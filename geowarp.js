const dufour_peyton_intersection = require("dufour-peyton-intersection");
const fastMax = require("fast-max");
const fastMin = require("fast-min");
const getDepth = require("get-depth");
const getTheoreticalMax = require("typed-array-ranges/get-max");
const getTheoreticalMin = require("typed-array-ranges/get-min");
const fasterMedian = require("faster-median");
const reprojectBoundingBox = require("reproject-bbox/pluggable");
const reprojectGeoJSON = require("reproject-geojson/pluggable");
const xdim = require("xdim");

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const uniq = arr => Array.from(new Set(arr)).sort((a, b) => b - a);

const range = ct => new Array(ct).fill(0).map((_, i) => i);

const forEach = (nums, no_data, cb) => {
  const len = nums.length;
  if (no_data) {
    for (let i = 0; i < len; i++) {
      const n = nums[i];
      if (n !== no_data) cb(n);
    }
  } else {
    for (let i = 0; i < len; i++) {
      cb(nums[i]);
    }
  }
};

const median = ({ nums, in_no_data, out_no_data }) => {
  const result = fasterMedian({ nums, no_data: in_no_data });
  return result === undefined ? out_no_data : result;
};

const max = ({ nums, in_no_data, out_no_data, theoretical_max }) => {
  const result = fastMax(nums, { no_data: in_no_data, theoretical_max });
  return result === undefined ? out_no_data : result;
};

const mean = (nums, in_no_data, out_no_data) => {
  let running_sum = 0;
  let count = 0;
  forEach(nums, in_no_data, n => {
    count++;
    running_sum += n;
  });
  return count === 0 ? out_no_data : running_sum / count;
};

const min = ({ nums, in_no_data, out_no_data, theoretical_min }) => {
  const result = fastMin(nums, { no_data: in_no_data, theoretical_min });
  return result === undefined ? out_no_data : result;
};

const mode = (nums, no_data) => {
  switch (nums.length) {
    case 0:
      return undefined;
    default:
      const counts = {};
      if (no_data) {
        for (let i = 0; i < nums.length; i++) {
          const n = nums[i];
          if (n !== no_data) {
            if (n in counts) counts[n].count++;
            else counts[n] = { n, count: 1 };
          }
        }
      } else {
        for (let i = 0; i < nums.length; i++) {
          const n = nums[i];
          if (n in counts) counts[n].count++;
          else counts[n] = { n, count: 1 };
        }
      }
      const items = Object.values(counts);
      const count = items.sort((a, b) => Math.sign(b.count - a.count))[0].count;
      return items.filter(it => it.count === count).map(it => it.n);
  }
};

const geowarp = function geowarp({
  debug_level = 0,
  in_data,
  in_bbox = undefined,
  in_layout = "[band][row,column]",
  in_srs,
  in_height,
  in_pixel_depth, // number of input bands
  in_pixel_height, // optional, automatically calculated from in_bbox
  in_pixel_width, // optional, automatically calculated from in_bbox
  in_width,
  in_no_data,
  out_array_types, // array of constructor names passed to internal call to xdim's prepareData function
  out_bands, // array of bands to keep and order, default is keeping all the bands in same order
  out_data, // single or multi-dimensional array that geowarp will fill in with the output
  out_pixel_depth, // number of output bands
  out_pixel_height, // optional, automatically calculated from out_bbox
  out_pixel_width, // optional, automatically calculated from out_bbox
  out_bbox = null,
  out_layout,
  out_srs,
  out_width = 256,
  out_height = 256,
  out_no_data = null,
  method = "median",
  read_bands = undefined, // which bands to read, used in conjunction with expr
  row_start = 0, // which row in output data to start writing at
  row_end,
  expr = undefined, // band expression function
  round = false, // whether to round output
  theoretical_min, // minimum theoretical value (e.g., 0 for unsigned integer arrays)
  theoretical_max, // maximum values (e.g., 255 for 8-bit unsigned integer arrays),
  inverse, // function to reproject [x, y] point from out_srs back to in_srs
  forward, // function to reproject [x, y] point from in_srs to out_srs
  cutline, // polygon or polygons defining areas to cut out (everything outside becomes no data)
  cutline_srs, // spatial reference system of the cutline
  cutline_forward // function to reproject [x, y] point from cutline_srs to out_srs
}) {
  if (debug_level >= 1) console.log("[geowarp] starting");

  const same_srs = in_srs === out_srs;
  if (debug_level >= 1) console.log("[geowarp] input and output srs are the same:", same_srs);

  // support for deprecated alias of inverse
  inverse ??= arguments[0].reproject;

  if (!same_srs) {
    if (!in_bbox) throw new Error("[geowarp] can't reproject without in_bbox");
    if (!out_bbox) {
      if (forward) out_bbox = reprojectBoundingBox({ bbox: in_bbox, reproject: forward });
      else throw new Error("[geowarp] must specify out_bbox or forward");
    }
  }

  if (!same_srs && typeof inverse !== "function") {
    throw new Error("[geowarp] you must specify a reproject function");
  }

  if (!in_height) throw new Error("[geowarp] you must provide in_height");
  if (!in_width) throw new Error("[geowarp] you must provide in_width");

  // if no output layout is specified
  // just return the data in the same layout as it is provided
  if (!out_layout) out_layout = in_layout;

  if (in_pixel_depth === undefined || in_pixel_depth === null) {
    if (in_layout.startsWith("[band]")) {
      in_pixel_depth = in_data.length;
    } else {
      const depth = getDepth(in_data);
      if (depth === 1) {
        // could be [row,column,band] or [band,row,column]
        in_pixel_depth = in_data.length / in_height / in_width;
      } else if (depth === 2) {
        // probably [row,column][band]
        in_pixel_depth = in_data[0].length;
      } else if (depth === 3) {
        // probably [row][column][band]
        in_pixel_depth = in_data[0][0].length;
      }
    }
  }

  if (debug_level >= 1) console.log("[geowarp] number of bands in source data:", in_pixel_depth);

  // extra processing step after we have read the pixel
  let process;
  if (expr) {
    process = expr; // maps ({ pixel }) to new pixel
  } else if (out_bands) {
    read_bands ??= uniq(out_bands);
    process = ({ pixel }) => out_bands.map(iband => pixel[read_bands.indexOf(iband)]);
  }

  if (!read_bands) {
    if (expr) read_bands = range(in_pixel_depth);
    else if (out_bands) read_bands = uniq(out_bands);
    else read_bands = range(in_pixel_depth);
  }
  if (debug_level >= 1) console.log("[geowarp] read_bands:", read_bands);

  out_pixel_depth ??= out_bands?.length ?? read_bands?.length ?? in_pixel_depth;

  // just resizing an image without reprojection
  if (same_srs && eq(in_bbox, out_bbox)) {
    out_srs = in_srs = null;
    in_bbox = [0, 0, in_width, in_height];
    out_bbox = [0, 0, out_width, out_height];
  }

  if (debug_level >= 1) console.log("[geowarp] method:", method);
  const [in_xmin, in_ymin, in_xmax, in_ymax] = in_bbox;

  in_pixel_height ??= (in_ymax - in_ymin) / in_height;
  in_pixel_width ??= (in_xmax - in_xmin) / in_width;
  if (debug_level >= 1) console.log("[geowarp] pixel height of source data:", in_pixel_height);
  if (debug_level >= 1) console.log("[geowarp] pixel width of source data:", in_pixel_width);

  const [out_xmin, out_ymin, out_xmax, out_ymax] = out_bbox;
  if (debug_level >= 1) console.log("[geowarp] out_xmin:", out_xmin);
  if (debug_level >= 1) console.log("[geowarp] out_ymin:", out_ymin);
  if (debug_level >= 1) console.log("[geowarp] out_xmax:", out_xmax);
  if (debug_level >= 1) console.log("[geowarp] out_ymax:", out_ymax);

  out_pixel_height ??= (out_ymax - out_ymin) / out_height;
  out_pixel_width ??= (out_xmax - out_xmin) / out_width;
  if (debug_level >= 1) console.log("[geowarp] out_pixel_height:", out_pixel_height);
  if (debug_level >= 1) console.log("[geowarp] out_pixel_width:", out_pixel_width);

  if (theoretical_min === undefined || theoretical_max === undefined) {
    try {
      const data_constructor = in_data[0].constructor.name;
      if (debug_level >= 1) console.log("[geowarp] data_constructor:", data_constructor);
      theoretical_min ??= getTheoreticalMin(data_constructor);
      theoretical_max ??= getTheoreticalMax(data_constructor);
      if (debug_level >= 1) console.log("[geowarp] theoretical_min:", theoretical_min);
      if (debug_level >= 1) console.log("[geowarp] theoretical_max:", theoretical_max);
    } catch (error) {
      // we want to log an error if it happens
      // even if we don't strictly need it to succeed
      console.error(error);
    }
  }

  if (![undefined, null, ""].includes(cutline_forward) && typeof cutline_forward !== "function") {
    throw new Error("[geowarp] cutline_forward must be of type function not " + typeof cutline);
  }

  // if cutline isn't in the projection of the output, reproject it
  const segments_by_row = new Array(out_height).fill(0).map(() => []);
  if (cutline && cutline_srs !== out_srs) {
    if (!cutline_forward) {
      // fallback to checking if we can use forward
      if (in_srs === cutline_srs) cutline_forward = forward;
      throw new Error("[geowarp] must specify cutline_forward when cutline_srs and out_srs differ");
    }
    cutline = reprojectGeoJSON(cutline, { reproject: cutline_forward });
  }

  if (cutline) {
    dufour_peyton_intersection.calculate({
      raster_bbox: out_bbox,
      raster_height: out_height,
      raster_width: out_width,
      pixel_height: out_pixel_height,
      pixel_width: out_pixel_width,
      geometry: cutline,
      per_row_segment: ({ row, columns }) => {
        segments_by_row[row].push(columns);
      }
    });
  } else {
    const full_width_row_segment = [0, out_width];
    for (let row_index = 0; row_index < out_height; row_index++) {
      segments_by_row[row_index].push(full_width_row_segment);
    }
  }

  const in_sizes = {
    band: in_pixel_depth,
    row: in_height,
    column: in_width
  };

  // dimensions of the output
  const out_sizes = {
    band: out_pixel_depth,
    row: out_height,
    column: out_width
  };

  out_data ??= xdim.prepareData({
    fill: out_no_data,
    layout: out_layout,
    sizes: out_sizes,
    arrayTypes: out_array_types
  }).data;

  const update = xdim.prepareUpdate({ data: out_data, layout: out_layout, sizes: out_sizes });

  const insert = ({ row, column, pixel }) => {
    pixel.forEach((value, band) => {
      update({
        point: { band, row, column },
        value
      });
    });
  };

  row_end ??= out_height;

  if (method === "near") {
    const select = xdim.prepareSelect({ data: in_data, layout: in_layout, sizes: in_sizes });
    const rmax = Math.min(row_end, out_height);
    for (let r = row_start; r < rmax; r++) {
      const y = out_ymax - out_pixel_height * r;
      const segments = segments_by_row[r];
      for (let iseg = 0; iseg < segments.length; iseg++) {
        const [cstart, cend] = segments[iseg];
        for (let c = cstart; c < cend; c++) {
          const x = out_xmin + out_pixel_width * c;
          const pt_out_srs = [x, y];
          const [x_in_srs, y_in_srs] = same_srs ? pt_out_srs : inverse(pt_out_srs);
          const xInRasterPixels = Math.floor((x_in_srs - in_xmin) / in_pixel_width);
          const yInRasterPixels = Math.floor((in_ymax - y_in_srs) / in_pixel_height);
          let pixel = [];
          for (let i = 0; i < read_bands.length; i++) {
            const read_band = read_bands[i];
            let { value: pixelBandValue } = select({
              point: {
                band: read_band,
                row: yInRasterPixels,
                column: xInRasterPixels
              }
            });

            if (pixelBandValue === undefined || pixelBandValue === in_no_data) {
              pixelBandValue = out_no_data;
            } else if (round) {
              pixelBandValue = Math.round(pixelBandValue);
            }
            pixel.push(pixelBandValue);
          }
          if (process) pixel = process({ pixel });
          insert({ row: r, column: c, pixel });
        }
      }
    }
  } else if (method === "bilinear") {
    const select = xdim.prepareSelect({ data: in_data, layout: in_layout, sizes: in_sizes });
    const rmax = Math.min(row_end, out_height);
    for (let r = row_start; r < rmax; r++) {
      const y = out_ymax - out_pixel_height * r;
      const segments = segments_by_row[r];
      for (let iseg = 0; iseg < segments.length; iseg++) {
        const [cstart, cend] = segments[iseg];
        for (let c = cstart; c < cend; c++) {
          const x = out_xmin + out_pixel_width * c;
          const pt_out_srs = [x, y];
          const [x_in_srs, y_in_srs] = same_srs ? pt_out_srs : inverse(pt_out_srs);

          const xInRasterPixels = (x_in_srs - in_xmin) / in_pixel_width;
          const yInRasterPixels = (in_ymax - y_in_srs) / in_pixel_height;

          // we offset in order to account for the fact that the pixel at index 0
          // is represented by a point at x=0.5 (the center of the pixel)
          const xInRasterPixelsOffset = xInRasterPixels - 0.5;
          const yInRasterPixelsOffset = yInRasterPixels - 0.5;

          const left = Math.floor(xInRasterPixelsOffset);
          const right = Math.ceil(xInRasterPixelsOffset);
          const bottom = Math.floor(yInRasterPixelsOffset);
          const top = Math.ceil(yInRasterPixelsOffset);

          const leftWeight = xInRasterPixels % 1;
          const rightWeight = 1 - leftWeight;
          const bottomWeight = yInRasterPixels % 1;
          const topWeight = 1 - bottomWeight;

          let pixel = new Array();
          for (let i = 0; i < read_bands.length; i++) {
            const read_band = read_bands[i];
            const { value: upperLeftValue } = select({ point: { band: read_band, row: top, column: left } });
            const { value: upperRightValue } = select({ point: { band: read_band, row: top, column: right } });
            const { value: lowerLeftValue } = select({ point: { band: read_band, row: bottom, column: left } });
            const { value: lowerRightValue } = select({ point: { band: read_band, row: bottom, column: right } });

            let topValue;
            if ((upperLeftValue === undefined || upperLeftValue === in_no_data) && (upperRightValue === undefined || upperRightValue === in_no_data)) {
              // keep topValue undefined
            } else if (upperLeftValue === undefined || upperLeftValue === in_no_data) {
              topValue = upperRightValue;
            } else if (upperRightValue === undefined || upperRightValue === in_no_data) {
              topValue = upperLeftValue;
            } else {
              topValue = leftWeight * upperLeftValue + rightWeight * upperRightValue;
            }

            let bottomValue;
            if ((lowerLeftValue === undefined || lowerLeftValue === in_no_data) && (lowerRightValue === undefined || lowerRightValue === in_no_data)) {
              // keep bottom value undefined
            } else if (lowerLeftValue === undefined || lowerLeftValue === in_no_data) {
              bottomValue = lowerRightValue;
            } else if (upperRightValue === undefined || upperRightValue === in_no_data) {
              bottomValue = lowerLeftValue;
            } else {
              bottomValue = leftWeight * lowerLeftValue + rightWeight * lowerRightValue;
            }

            let value;
            if (topValue === undefined && bottomValue === undefined) {
              value = out_no_data;
            } else if (topValue === undefined) {
              value = bottomValue;
            } else if (bottomValue === undefined) {
              value = topValue;
            } else {
              value = bottomWeight * topValue + topWeight * bottomValue;
            }

            if (round) value = Math.round(value);
            pixel.push(value);
          }
          if (process) pixel = process({ pixel });
          insert({ row: r, column: c, pixel });
        }
      }
    }
  } else {
    let top, left, bottom, right;
    bottom = out_ymax;
    const rmax = Math.min(row_end, out_height);
    for (let r = row_start; r < rmax; r++) {
      top = bottom;
      bottom = top - out_pixel_height;
      const segments = segments_by_row[r];
      for (let iseg = 0; iseg < segments.length; iseg++) {
        const [cstart, cend] = segments[iseg];
        right = out_xmin + out_pixel_width * cstart;
        for (let c = cstart; c < cend; c++) {
          left = right;
          right = left + out_pixel_width;
          // top, left, bottom, right is the sample area in the coordinate system of the output

          // convert to bbox of input coordinate system
          const bbox_in_srs = same_srs ? [left, bottom, right, top] : [...inverse([left, bottom]), ...inverse([right, top])];
          if (debug_level >= 3) console.log("[geowarp] bbox_in_srs:", bbox_in_srs);
          const [xmin_in_srs, ymin_in_srs, xmax_in_srs, ymax_in_srs] = bbox_in_srs;

          // convert bbox in input srs to raster pixels
          const leftInRasterPixels = (xmin_in_srs - in_xmin) / in_pixel_width;
          if (debug_level >= 4) console.log("[geowarp] leftInRasterPixels:", leftInRasterPixels);
          const rightInRasterPixels = (xmax_in_srs - in_xmin) / in_pixel_width;
          if (debug_level >= 4) console.log("[geowarp] rightInRasterPixels:", rightInRasterPixels);
          const topInRasterPixels = (in_ymax - ymax_in_srs) / in_pixel_height;
          if (debug_level >= 4) console.log("[geowarp] topInRasterPixels:", topInRasterPixels);
          const bottomInRasterPixels = (in_ymax - ymin_in_srs) / in_pixel_height;
          if (debug_level >= 4) console.log("[geowarp] bottomInRasterPixels:", bottomInRasterPixels);

          // round and make sure leftSample isn't less than zero
          let leftSample = Math.round(leftInRasterPixels);
          let rightSample = Math.round(rightInRasterPixels);
          let topSample = Math.round(topInRasterPixels);
          let bottomSample = Math.round(bottomInRasterPixels);

          let pixel = [];
          if (leftSample >= in_width || rightSample < 0 || bottomSample < 0 || topSample >= in_height) {
            pixel = new Array(read_bands.length).fill(in_no_data);
          } else {
            // clamp edges to prevent clipping outside bounds
            leftSample = Math.max(0, leftSample);
            rightSample = Math.min(rightSample, in_width);
            topSample = Math.max(0, topSample);
            bottomSample = Math.min(bottomSample, in_height);

            for (let i = 0; i < read_bands.length; i++) {
              const read_band = read_bands[i];
              const { data: values } = xdim.clip({
                data: in_data,
                flat: true,
                layout: in_layout,
                sizes: in_sizes,
                rect: {
                  band: [read_band, read_band],
                  row: [topSample, Math.max(topSample, bottomSample - 1)],
                  column: [leftSample, Math.max(leftSample, rightSample - 1)]
                }
              });

              let pixelBandValue = null;
              if (typeof method === "function") {
                pixelBandValue = method({ values });
              } else if (method === "max") {
                pixelBandValue = max({ nums: values, in_no_data, out_no_data, theoretical_max: undefined });
              } else if (method === "mean") {
                pixelBandValue = mean(values, in_no_data, out_no_data);
              } else if (method === "median") {
                pixelBandValue = median({ nums: values, in_no_data, out_no_data });
              } else if (method === "min") {
                pixelBandValue = min({ nums: values, in_no_data, out_no_data, theoretical_min: undefined });
              } else if (method.startsWith("mode")) {
                const modes = mode(values);
                const len = modes.length;
                if (len === 1) {
                  pixelBandValue = modes[0];
                } else {
                  if (method === "mode") {
                    pixelBandValue = modes[0];
                  } else if (method === "mode-max") {
                    pixelBandValue = max({ nums: values });
                  } else if (method === "mode-mean") {
                    pixelBandValue = mean(values);
                  } else if (method === "mode-median") {
                    pixelBandValue = median({ nums: values });
                  } else if (method === "mode-min") {
                    pixelBandValue = min({ nums: values });
                  }
                }
              } else {
                throw new Error(`[geowarp] unknown method "${method}"`);
              }
              if (round) pixelBandValue = Math.round(pixelBandValue);
              pixel.push(pixelBandValue);
            }
          }

          if (process) pixel = process({ pixel });
          insert({ row: r, column: c, pixel });
        }
      }
    }
  }

  if (debug_level >= 1) console.log("[geowarp] finishing");
  return {
    data: out_data,
    out_bands,
    out_layout,
    out_pixel_height,
    out_pixel_width,
    read_bands
  };
};

if (typeof module === "object") {
  module.exports = geowarp;
  module.exports.default = geowarp;
}
if (typeof window === "object") window.geowarp = geowarp;
if (typeof self === "object") self.geowarp = geowarp;

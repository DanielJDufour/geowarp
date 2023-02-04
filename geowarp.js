const { booleanIntersects, intersect, polygon } = require("bbox-fns");
const dufour_peyton_intersection = require("dufour-peyton-intersection");
const fastMax = require("fast-max");
const fastMin = require("fast-min");
const getDepth = require("get-depth");
const getTheoreticalMax = require("typed-array-ranges/get-max");
const getTheoreticalMin = require("typed-array-ranges/get-min");
const fasterMedian = require("faster-median");
const reprojectBoundingBox = require("reproject-bbox/pluggable");
const reprojectGeoJSON = require("reproject-geojson/pluggable");
const { turbocharge } = require("proj-turbo");
const segflip = require("segflip");
const xdim = require("xdim");

const clamp = (n, min, max) => (n < min ? min : n > max ? max : n);

// const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

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

const mean = (nums, in_no_data) => {
  let running_sum = 0;
  let count = 0;
  forEach(nums, in_no_data, n => {
    count++;
    running_sum += n;
  });
  return count === 0 ? undefined : running_sum / count;
};

const mode = (nums, no_data) => {
  if (nums.length === 0) return undefined;

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
  cutline_bbox, // bounding box of the cutline geometry, can lead to a performance increase when combined with turbo
  cutline_srs, // spatial reference system of the cutline
  cutline_forward, // function to reproject [x, y] point from cutline_srs to out_srs
  cutline_strategy = "outside", // cut out the pixels inside or outside the cutline
  turbo = false, // enable experimental turbocharging via proj-turbo
  insert, // over-ride function that inserts data into output multi-dimensional array
  skip_no_data_strategy // skip processing pixels if "any" or "all" values are "no data"
}) {
  if (debug_level >= 1) console.log("[geowarp] starting");
  const start_time = debug_level >= 1 ? performance.now() : 0;

  const same_srs = in_srs === out_srs;
  if (debug_level >= 1) console.log("[geowarp] input and output srs are the same:", same_srs);

  if (debug_level >= 1) console.log("[geowarp] skip_no_data_strategy:", skip_no_data_strategy);

  // support for deprecated alias of inverse
  inverse ??= arguments[0].reproject;

  let in_bbox_out_srs, out_bbox_in_srs, intersect_bbox_in_srs, intersect_bbox_out_srs;

  if (!same_srs) {
    if (!in_bbox) throw new Error("[geowarp] can't reproject without in_bbox");
    if (!out_bbox) {
      if (forward) out_bbox = in_bbox_out_srs = intersect_bbox_out_srs = reprojectBoundingBox({ bbox: in_bbox, reproject: forward });
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

  if (!read_bands) {
    if (expr) read_bands = range(in_pixel_depth);
    else if (out_bands) read_bands = uniq(out_bands);
    else read_bands = range(in_pixel_depth);
  }

  out_bands ??= read_bands;

  if (round && typeof out_no_data === "number") out_no_data = Math.round(out_no_data);

  // processing step after we have read the raw pixel values
  let process;
  if (expr) {
    if (round) {
      process = ({ pixel }) => expr(pixel).map(n => Math.round(n));
    } else {
      process = expr; // maps ({ pixel }) to new pixel
    }
  } else {
    // mapping index of band in output pixel to index in read band
    const out_bands_to_read_bands = out_bands.map(iband => read_bands.indexOf(iband));

    // we create a different processing pipeline depending on rounding
    // because we don't want to check if we should round for every single pixel
    if (round) {
      process = ({ pixel }) =>
        out_bands_to_read_bands.map(iband => {
          const value = pixel[iband];
          return value === undefined || value === in_no_data ? out_no_data : Math.round(value);
        });
    } else {
      // without rounding
      process = ({ pixel }) =>
        out_bands_to_read_bands.map(iband => {
          const value = pixel[iband];
          return value === undefined || value === in_no_data ? out_no_data : value;
        });
    }
  }

  if (debug_level >= 1) console.log("[geowarp] read_bands:", read_bands);

  out_pixel_depth ??= out_bands?.length ?? read_bands?.length ?? in_pixel_depth;

  if (debug_level >= 1) console.log("[geowarp] out_height:", out_height);
  if (debug_level >= 1) console.log("[geowarp] out_width:", out_width);

  if (same_srs && in_bbox && !out_bbox) {
    out_bbox = in_bbox;
  }

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

  const half_in_pixel_height = in_pixel_height / 2;
  const half_in_pixel_width = in_pixel_width / 2;
  const half_out_pixel_height = out_pixel_height / 2;
  const half_out_pixel_width = out_pixel_width / 2;

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
  let segments_by_row = new Array(out_height).fill(0).map(() => []);
  if (cutline && cutline_srs !== out_srs) {
    if (!cutline_forward) {
      // fallback to checking if we can use forward
      if (in_srs === cutline_srs) cutline_forward = forward;
      throw new Error("[geowarp] must specify cutline_forward when cutline_srs and out_srs differ");
    }

    let cutline_forward_turbocharged;
    if (cutline_forward && cutline_bbox) {
      cutline_forward_turbocharged = turbocharge({
        bbox: cutline_bbox,
        debug_level,
        quiet: true,
        reproject: cutline_forward,
        threshold: [half_out_pixel_width, half_out_pixel_height]
      })?.reproject;
    }

    cutline = reprojectGeoJSON(cutline, { reproject: cutline_forward_turbocharged || cutline_forward });
  }

  const full_width_row_segment = [0, out_width - 1];

  if (cutline) {
    const intersections = dufour_peyton_intersection.calculate({
      raster_bbox: out_bbox,
      raster_height: out_height,
      raster_width: out_width,
      pixel_height: out_pixel_height,
      pixel_width: out_pixel_width,
      geometry: cutline
    });

    // we don't use per_row_segment because that can lead to overlap
    intersections.rows.forEach((segs, irow) => {
      segments_by_row[irow] = segs;
    });

    if (cutline_strategy === "inside") {
      // flip the inside/outside segments

      segments_by_row = segments_by_row.map(segs => {
        if (segs.length === 0) {
          return [full_width_row_segment];
        } else {
          return segflip({
            segments: segs,
            min: 0,
            max: out_width - 1,
            debug: false
          });
        }
      });
    }
  } else {
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

  if (typeof insert !== "function") {
    const update = xdim.prepareUpdate({ data: out_data, layout: out_layout, sizes: out_sizes });

    insert = ({ row, column, pixel, raw }) => {
      pixel.forEach((value, band) => {
        update({
          point: { band, row, column },
          value
        });
      });
    };
  }

  row_end ??= out_height;

  if (debug_level >= 1) console.log("[geowarp] method:", method);

  let forward_turbocharged, inverse_turbocharged;
  if (turbo) {
    if (forward) {
      out_bbox_in_srs ??= reprojectBoundingBox({ bbox: out_bbox, reproject: inverse });
      intersect_bbox_in_srs ??= intersect(in_bbox, out_bbox_in_srs);
      forward_turbocharged = turbocharge({
        bbox: intersect_bbox_in_srs,
        debug_level,
        quiet: true,
        reproject: forward,
        threshold: [half_out_pixel_width, half_out_pixel_height]
      });
    }
    if (inverse) {
      in_bbox_out_srs ??= reprojectBoundingBox({ bbox: in_bbox, reproject: forward });
      intersect_bbox_out_srs ??= intersect(out_bbox, in_bbox_out_srs);
      inverse_turbocharged = turbocharge({
        bbox: intersect_bbox_out_srs,
        debug_level,
        quiet: true,
        reproject: inverse,
        threshold: [half_in_pixel_width, half_in_pixel_height]
      });
    }
  }
  if (debug_level >= 2) {
    if (forward_turbocharged) console.log("[geowarp] turbocharged forward");
    if (inverse_turbocharged) console.log("[geowarp] turbocharged inverse");
  }
  const fwd = forward_turbocharged?.reproject || forward;
  const inv = inverse_turbocharged?.reproject || inverse;

  const select = xdim.prepareSelect({ data: in_data, layout: in_layout, sizes: in_sizes });

  let out_pixel_height_in_srs, out_pixel_width_in_srs, pixel_height_ratio, pixel_width_ratio;
  if (method === "near-vectorize") {
    if (debug_level >= 2) console.log('[geowarp] choosing between "near" and "vectorize" for best speed');

    out_bbox_in_srs ??= reprojectBoundingBox({ bbox: out_bbox, reproject: inverse });

    out_pixel_height_in_srs = (out_bbox_in_srs[3] - out_bbox_in_srs[1]) / out_height;
    out_pixel_width_in_srs = (out_bbox_in_srs[2] - out_bbox_in_srs[0]) / out_width;

    pixel_height_ratio = out_pixel_height_in_srs / in_pixel_height;
    pixel_width_ratio = out_pixel_width_in_srs / in_pixel_width;

    if (debug_level >= 2) console.log("[geowarp] pixel_height_ratio:", pixel_height_ratio);
    if (debug_level >= 2) console.log("[geowarp] pixel_width_ratio:", pixel_width_ratio);
    if (pixel_height_ratio < 0.1 && pixel_width_ratio < 0.1) {
      method = "vectorize";
      if (debug_level >= 1) console.log('[geowarp] selected "vectorize" method as it is likely to be faster');
    } else {
      method = "near";
      if (debug_level >= 1) console.log('[geowarp] selected "near" method as it is likely to be faster');
    }
  }

  const should_skip =
    skip_no_data_strategy === "any"
      ? px => px.includes(undefined) || px.includes(in_no_data)
      : skip_no_data_strategy === "all"
      ? px => px.every(n => n === in_no_data)
      : () => false;

  if (method === "vectorize") {
    // reproject bounding box of output (e.g. a tile) into the spatial reference system of the input data
    out_bbox_in_srs ??= reprojectBoundingBox({ bbox: out_bbox, reproject: inverse });
    let [left, bottom, right, top] = out_bbox_in_srs;

    out_pixel_height_in_srs ??= (top - bottom) / out_height;
    if (in_pixel_height < out_pixel_height_in_srs) {
      if (debug_level >= 1) {
        console.warn(`normalized output pixel height of ${out_pixel_height_in_srs} is larger than input pixel height of ${in_pixel_height}`);
      }
    }

    out_pixel_width_in_srs ??= (right - left) / out_width;
    if (in_pixel_width < out_pixel_width_in_srs) {
      if (debug_level >= 1) {
        console.warn(`normalized output pixel width of ${out_pixel_width_in_srs} is larger than input pixel width of ${in_pixel_width}`);
      }
    }

    // if have a cutline do additional clamping
    const cutline_in_srs = cutline && reprojectGeoJSON(cutline, { reproject: inverse });

    // in the future we might want to pull the function getBoundingBox into its own repo
    const cutline_bbox_in_srs = cutline && dufour_peyton_intersection.getBoundingBox(cutline_in_srs);

    if (!cutline || booleanIntersects(in_bbox, cutline_bbox_in_srs)) {
      // update bounding box we sample from based on extent of cutline
      [left, bottom, right, top] = cutline && cutline_strategy !== "inside" ? intersect(out_bbox_in_srs, cutline_bbox_in_srs) : out_bbox_in_srs;

      if ((left < in_xmax && bottom < in_ymax && right > in_xmin) || top < in_ymin) {
        const in_row_start = Math.floor((in_ymax - top) / in_pixel_height);
        const in_row_start_clamped = clamp(in_row_start, 0, in_height - 1);
        const in_row_end = Math.min(Math.floor((in_ymax - bottom) / in_pixel_height), in_height - 1);
        const in_row_end_clamped = clamp(in_row_end, 0, in_height - 1);

        const in_column_start = Math.floor((left - in_xmin) / in_pixel_width);
        const in_column_start_clamped = clamp(in_column_start, 0, in_width - 1);
        const in_column_end = Math.min(Math.floor((right - in_xmin) / in_pixel_width), in_width - 1);
        const in_column_end_clamped = clamp(in_column_end, 0, in_width - 1);

        let pixel_ymin = in_ymax - in_row_start_clamped * in_pixel_height;
        for (let r = in_row_start_clamped; r <= in_row_end_clamped; r++) {
          const pixel_ymax = pixel_ymin;
          pixel_ymin = pixel_ymax - in_pixel_height;
          for (let c = in_column_start_clamped; c <= in_column_end_clamped; c++) {
            const raw_values = read_bands.map(band => select({ point: { band, row: r, column: c } }).value);

            if (should_skip(raw_values)) continue;

            // apply band math expression, no data mapping, and rounding when applicable
            const pixel = process({ pixel: raw_values });

            const pixel_xmin = in_xmin + c * in_pixel_width;
            const pixel_xmax = pixel_xmin + in_pixel_width;

            const pixel_bbox = [pixel_xmin, pixel_ymin, pixel_xmax, pixel_ymax];

            // convert pixel to a rectangle polygon in srs of input data
            const rect = polygon(pixel_bbox);

            // reproject pixel rectangle from input to output srs
            const pixel_geometry_in_out_srs = reprojectGeoJSON(rect, { reproject: fwd });

            const intersect_options = {
              debug: false,
              raster_bbox: out_bbox,
              raster_height: out_height,
              raster_width: out_width,
              pixel_height: out_pixel_height,
              pixel_width: out_pixel_width,
              geometry: pixel_geometry_in_out_srs
            };
            if (cutline) {
              intersect_options.per_pixel = ({ row, column }) => {
                if (segments_by_row[row].some(([start, end]) => column >= start && column <= end)) {
                  insert({ raw: raw_values, pixel, row, column });
                }
              };
            } else {
              intersect_options.per_pixel = ({ row, column }) => {
                insert({ raw: raw_values, pixel, row, column });
              };
            }
            dufour_peyton_intersection.calculate(intersect_options);
          }
        }
      }
    }
  } else if (method === "near") {
    const rmax = Math.min(row_end, out_height);
    let y = out_ymax + half_out_pixel_height - row_start * out_pixel_height;
    for (let r = row_start; r < rmax; r++) {
      y -= out_pixel_height;
      const segments = segments_by_row[r];
      for (let iseg = 0; iseg < segments.length; iseg++) {
        const [cstart, cend] = segments[iseg];
        for (let c = cstart; c <= cend; c++) {
          const x = out_xmin + c * out_pixel_width + half_out_pixel_width;
          const pt_out_srs = [x, y];
          const [x_in_srs, y_in_srs] = same_srs ? pt_out_srs : inv(pt_out_srs);
          const xInRasterPixels = Math.floor((x_in_srs - in_xmin) / in_pixel_width);
          const yInRasterPixels = Math.floor((in_ymax - y_in_srs) / in_pixel_height);

          let raw_values = [];

          if (xInRasterPixels < 0 || yInRasterPixels < 0 || xInRasterPixels >= in_width || yInRasterPixels >= in_height) {
            // through reprojection, we can sometimes find ourselves just across the edge
            raw_values = new Array(read_bands.length).fill(in_no_data);
          } else {
            raw_values = read_bands.map(
              band =>
                select({
                  point: {
                    band,
                    row: yInRasterPixels,
                    column: xInRasterPixels
                  }
                }).value
            );
          }

          if (should_skip(raw_values)) continue;
          const pixel = process({ pixel: raw_values });
          insert({ row: r, column: c, pixel, raw: raw_values });
        }
      }
    }
  } else if (method === "bilinear") {
    // see https://en.wikipedia.org/wiki/Bilinear_interpolation

    const rmax = Math.min(row_end, out_height);

    let y = out_ymax + half_out_pixel_height - row_start * out_pixel_height;
    for (let r = row_start; r < rmax; r++) {
      y -= out_pixel_height;
      const segments = segments_by_row[r];
      for (let iseg = 0; iseg < segments.length; iseg++) {
        const [cstart, cend] = segments[iseg];
        for (let c = cstart; c <= cend; c++) {
          const x = out_xmin + c * out_pixel_width + half_out_pixel_width;
          const pt_out_srs = [x, y];
          const [x_in_srs, y_in_srs] = same_srs ? pt_out_srs : inv(pt_out_srs);

          const xInRasterPixels = (x_in_srs - in_xmin) / in_pixel_width;
          const yInRasterPixels = (in_ymax - y_in_srs) / in_pixel_height;

          const left = Math.floor(xInRasterPixels);
          const right = Math.ceil(xInRasterPixels);
          const top = Math.floor(yInRasterPixels);
          const bottom = Math.ceil(yInRasterPixels);

          const leftWeight = right - xInRasterPixels;
          const rightWeight = xInRasterPixels - left;
          const topWeight = bottom - yInRasterPixels;
          const bottomWeight = yInRasterPixels - top;

          const leftInvalid = left < 0 || left >= in_width;
          const rightInvalid = right < 0 || right >= in_width;
          const topInvalid = top < 0 || top >= in_height;
          const bottomInvalid = bottom < 0 || bottom >= in_height;

          const upperLeftInvalid = topInvalid || leftInvalid;
          const upperRightInvalid = topInvalid || rightInvalid;
          const lowerLeftInvalid = bottomInvalid || leftInvalid;
          const lowerRightInvalid = bottomInvalid || rightInvalid;

          const raw_values = new Array();
          for (let i = 0; i < read_bands.length; i++) {
            const read_band = read_bands[i];

            const upperLeftValue = upperLeftInvalid ? in_no_data : select({ point: { band: read_band, row: top, column: left } }).value;
            const upperRightValue = upperRightInvalid ? in_no_data : select({ point: { band: read_band, row: top, column: right } }).value;
            const lowerLeftValue = lowerLeftInvalid ? in_no_data : select({ point: { band: read_band, row: bottom, column: left } }).value;
            const lowerRightValue = lowerRightInvalid ? in_no_data : select({ point: { band: read_band, row: bottom, column: right } }).value;

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
            } else if (lowerRightValue === undefined || lowerRightValue === in_no_data) {
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
              value = bottomWeight * bottomValue + topWeight * topValue;
            }

            raw_values.push(value);
          }
          if (should_skip(raw_values)) continue;
          const pixel = process({ pixel: raw_values });
          insert({ row: r, column: c, pixel, raw: raw_values });
        }
      }
    }
  } else {
    let calc;
    if (typeof method === "function") {
      calc = values => (values.length === 0 ? in_no_data : method({ values }));
    } else if (method === "max") {
      calc = values => (values.length === 0 ? in_no_data : fastMax(values, { no_data: in_no_data, theoretical_max }));
    } else if (method === "mean") {
      calc = values => (values.length === 0 ? in_no_data : mean(values, in_no_data));
    } else if (method === "median") {
      calc = values => (values.length === 0 ? in_no_data : fasterMedian({ nums: values, no_data: in_no_data }));
    } else if (method === "min") {
      calc = values => (values.length === 0 ? in_no_data : fastMin(values, { no_data: in_no_data, theoretical_min }));
    } else if (method === "mode") {
      calc = values => (values.length === 0 ? in_no_data : mode(values)[0]);
    } else if (method === "mode-max") {
      calc = values => (values.length === 0 ? in_no_data : fastMax(mode(values)));
    } else if (method === "mode-mean") {
      calc = values => (values.length === 0 ? in_no_data : mean(mode(values)));
    } else if (method === "mode-median") {
      calc = values => (values.length === 0 ? in_no_data : fasterMedian({ nums: mode(values) }));
    } else if (method === "mode-min") {
      calc = values => (values.length === 0 ? in_no_data : fastMin(mode(values)));
    } else {
      throw new Error(`[geowarp] unknown method "${method}"`);
    }

    let top, left, bottom, right;
    bottom = out_ymax - row_start * row_start;
    const rmax = Math.min(row_end, out_height);
    for (let r = row_start; r < rmax; r++) {
      top = bottom;
      bottom = top - out_pixel_height;
      const segments = segments_by_row[r];
      for (let iseg = 0; iseg < segments.length; iseg++) {
        const [cstart, cend] = segments[iseg];
        right = out_xmin + out_pixel_width * cstart;
        for (let c = cstart; c <= cend; c++) {
          left = right;
          right = left + out_pixel_width;
          // top, left, bottom, right is the sample area in the coordinate system of the output

          // convert to bbox of input coordinate system
          const bbox_in_srs = same_srs ? [left, bottom, right, top] : reprojectBoundingBox({ bbox: [left, bottom, right, top], reproject: inv });
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

          let leftSample = Math.round(leftInRasterPixels);
          let rightSample = Math.round(rightInRasterPixels);
          let topSample = Math.round(topInRasterPixels);
          let bottomSample = Math.round(bottomInRasterPixels);

          // if output pixel isn't large enough to sample an input pixel
          // just pick input pixel at the center of the output pixel
          if (leftSample === rightSample) {
            const xCenterSample = (rightInRasterPixels + leftInRasterPixels) / 2;
            leftSample = Math.floor(xCenterSample);
            rightSample = leftSample + 1;
          }
          if (topSample === bottomSample) {
            const yCenterSample = (topInRasterPixels + bottomInRasterPixels) / 2;
            topSample = Math.floor(yCenterSample);
            bottomSample = topSample + 1;
          }

          let raw_values = [];
          if (leftSample >= in_width || rightSample < 0 || bottomSample < 0 || topSample >= in_height) {
            raw_values = new Array(read_bands.length).fill(in_no_data);
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
              const valid_values = values.filter(v => v !== undefined && v !== in_no_data);
              raw_values.push(calc(valid_values));
            }
          }

          if (should_skip(raw_values)) continue;
          const pixel = process({ pixel: raw_values });
          insert({ row: r, column: c, pixel, raw: raw_values });
        }
      }
    }
  }

  if (debug_level >= 1) console.log("[geowarp] took " + (performance.now() - start_time).toFixed(0) + "ms");
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

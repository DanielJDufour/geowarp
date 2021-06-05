const fastMax = require("fast-max");
const fastMin = require("fast-min");
const getTheoreticalMax = require("typed-array-ranges/get-max");
const getTheoreticalMin = require("typed-array-ranges/get-min");
const fasterMedian = require("faster-median");

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

const geowarp = ({
  debug_level = 0,
  reproject, // equivalent of proj4(source, target).inverse()
  in_data,
  in_bbox,
  in_srs,
  in_height,
  in_width,
  in_no_data,
  out_bbox,
  out_srs,
  out_width = 256,
  out_height = 256,
  out_no_data = null,
  method = "median",
  round = false, // whether to round output
  theoretical_min, // minimum theoretical value (e.g., 0 for unsigned integer arrays)
  theoretical_max, // maximum values (e.g., 255 for 8-bit unsigned integer arrays)
}) => {
  if (debug_level) console.log("[geowarp] starting");

  const sameSRS = in_srs === out_srs;
  if (debug_level) console.log("[geowarp] input and output srs are the same:", sameSRS);

  if (!sameSRS && typeof reproject !== "function") {
    throw new Error("[geowarp] you must specify a reproject function");
  }

  if (!in_height) throw new Error("[geowarp] you must provide in_height");
  if (!in_width) throw new Error("[geowarp] you must provide in_width");

  const num_bands = in_data.length;
  if (debug_level) console.log("[geowarp] number of bands in source data:", num_bands);

  if (debug_level) console.log("[geowarp] method:", method);
  const [in_xmin, in_ymin, in_xmax, in_ymax] = in_bbox;

  const in_pixel_height = (in_ymax - in_ymin) / in_height;
  const in_pixel_width = (in_xmax - in_xmin) / in_width;
  if (debug_level) console.log("[geowarp] pixel height of source data:", in_pixel_height);
  if (debug_level) console.log("[geowarp] pixel width of source data:", in_pixel_width);

  const [out_xmin, out_ymin, out_xmax, out_ymax] = out_bbox;
  if (debug_level) console.log("[geowarp] out_xmin:", out_xmin);
  if (debug_level) console.log("[geowarp] out_ymin:", out_ymin);
  if (debug_level) console.log("[geowarp] out_xmax:", out_xmax);
  if (debug_level) console.log("[geowarp] out_ymax:", out_ymax);

  const out_pixel_height = (out_ymax - out_ymin) / out_height;
  const out_pixel_width = (out_xmax - out_xmin) / out_width;
  if (debug_level) console.log("[geowarp] out_pixel_height:", out_pixel_height);
  if (debug_level) console.log("[geowarp] out_pixel_width:", out_pixel_width);

  if (theoretical_min === undefined || theoretical_max === undefined) {
    try {
      const data_constructor = in_data[0].constructor.name;
      if (debug_level) console.log("[geowarp] data_constructor:", data_constructor);
      if (theoretical_min === undefined) theoretical_min = getTheoreticalMin(data_constructor);
      if (theoretical_max === undefined) theoretical_max = getTheoreticalMax(data_constructor);
      if (debug_level) console.log("[geowarp] theoretical_min:", theoretical_min);
      if (debug_level) console.log("[geowarp] theoretical_max:", theoretical_max);
    } catch (error) {
      // we want to log an error if it happens
      // even if we don't strictly need it to succeed
      console.error(error);
    }
  }

  // iterate over pixels in the out box
  const rows = [];

  if (method === "near") {
    for (let r = 0; r < out_height; r++) {
      const row = [];
      const y = out_ymax - out_pixel_height * r;
      for (let c = 0; c < out_width; c++) {
        const x = out_xmin + out_pixel_width * c;
        const pt_out_srs = [x, y];
        const [x_in_srs, y_in_srs] = sameSRS ? pt_out_srs : reproject(pt_out_srs);
        const xInRasterPixels = Math.round((x_in_srs - in_xmin) / in_pixel_width);
        const yInRasterPixels = Math.round((in_ymax - y_in_srs) / in_pixel_height);
        const i = yInRasterPixels * in_width + xInRasterPixels;
        const pixel = [];
        for (let b = 0; b < num_bands; b++) {
          let pixelBandValue = in_data[b][i];
          if (pixelBandValue === undefined || pixelBandValue === in_no_data) {
            pixelBandValue = out_no_data;
          } else if (round) {
            pixelBandValue = Math.round(pixelBandValue);
          }
          pixel.push(pixelBandValue);
        }
        row.push(pixel);
      }
      rows.push(row);
    }
  } else if (method === "bilinear") {
    for (let r = 0; r < out_height; r++) {
      const row = [];
      const y = out_ymax - out_pixel_height * r;
      for (let c = 0; c < out_width; c++) {
        const x = out_xmin + out_pixel_width * c;
        const pt_out_srs = [x, y];
        const [x_in_srs, y_in_srs] = sameSRS ? pt_out_srs : reproject(pt_out_srs);

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

        const pixel = [];
        for (let b = 0; b < num_bands; b++) {
          const band = in_data[b];

          const upperLeftValue = band[top * in_width + left];
          const upperRightValue = band[top * in_width + right];
          const lowerLeftValue = band[bottom * in_width + left];
          const lowerRightValue = band[bottom * in_width + right];

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
        row.push(pixel);
      }
      rows.push(row);
    }
  } else {
    let top, left, bottom, right;
    bottom = out_ymax;
    for (let r = 0; r < out_height; r++) {
      const row = [];
      top = bottom;
      bottom = top - out_pixel_height;
      right = out_xmin;
      for (let c = 0; c < out_width; c++) {
        left = right;
        right = left + out_pixel_width;
        // top, left, bottom, right is the sample area in the coordinate system of the output

        // convert to bbox of input coordinate system
        const bbox_in_srs = sameSRS ? [left, bottom, right, top] : [...reproject([left, bottom]), ...reproject([right, top])];
        if (debug_level >= 3) console.log("bbox_in_srs:", bbox_in_srs);
        const [xmin_in_srs, ymin_in_srs, xmax_in_srs, ymax_in_srs] = bbox_in_srs;

        // convert bbox in input srs to raster pixels
        const leftInRasterPixels = (xmin_in_srs - in_xmin) / in_pixel_width;
        const rightInRasterPixels = (xmax_in_srs - in_xmin) / in_pixel_width;
        const topInRasterPixels = (in_ymax - ymax_in_srs) / in_pixel_height;
        const bottomInRasterPixels = (in_ymax - ymin_in_srs) / in_pixel_height;
        // console.log({xmin_in_srs, in_xmin, leftInRasterPixels, rightInRasterPixels, topInRasterPixels, bottomInRasterPixels});

        const pixel = [];
        const leftSample = Math.round(leftInRasterPixels);
        const rightSample = Math.round(rightInRasterPixels);
        const topSample = Math.round(topInRasterPixels);
        const bottomSample = Math.round(bottomInRasterPixels);
        for (let b = 0; b < num_bands; b++) {
          const band = in_data[b];
          // const values = new band.constructor((bottomSample - topSample + 1) * (rightSample - leftSample + 1));
          const values = [];
          for (let y = topSample, i = 0; y <= bottomSample; y++) {
            const start = y * in_width;
            for (let x = leftSample; x <= rightSample; x++) {
              // assuming flattened data by band
              // values[i++] = band[start + x];
              values.push(band[start + x]);
            }
          }
          // console.log("values:", JSON.stringify(values));

          let pixelBandValue = null;
          if (method === "max") {
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
          }
          if (round) pixelBandValue = Math.round(pixelBandValue);
          pixel.push(pixelBandValue);
        }
        row.push(pixel);
      }
      rows.push(row);
    }
  }

  if (debug_level) console.log("[geowarp] finishing");
  return { data: rows };
};

if (typeof module === "object") module.exports = geowarp;
if (typeof window === "object") window.geowarp = geowarp;
if (typeof self === "object") self.geowarp = geowarp;

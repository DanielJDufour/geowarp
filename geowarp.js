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

const max = (nums, in_no_data, out_no_data) => {
  let result = -Infinity;
  forEach(nums, in_no_data, n => {
    if (n > result) result = n;
  });
  return result === -Infinity ? out_no_data : result;
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

const min = (nums, in_no_data, out_no_data) => {
  let result = Infinity;
  forEach(nums, in_no_data, n => {
    if (n < result) result = n;
  });
  return result === Infinity ? out_no_data : result;
};

const median = (nums, in_no_data, out_no_data) => {
  nums = nums.filter(n => n !== in_no_data).sort();
  switch (nums.length) {
    case 0:
      return out_no_data;
    case 1:
      return nums[0];
    default:
      const mid = nums.length / 2;
      if (nums.length % 2 === 0) {
        return (nums[mid - 1] + nums[mid]) / 2;
      } else {
        return nums[Math.floor(mid)];
      }
  }
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
}) => {
  if (debug_level) console.log("[geowarp] starting");

  const sameSRS = in_srs === out_srs;

  if (!sameSRS && typeof reproject !== "function") {
    throw new Error("[geowarp] you must specify a reproject function");
  }

  if (!in_height) throw new Error("[geowarp] you must provide in_height");
  if (!in_width) throw new Error("[geowarp] you must provide in_width");

  const num_bands = in_data.length;
  if (debug_level) console.log("[geowarp] number of bands in source data:", num_bands);

  const [in_xmin, in_ymin, in_xmax, in_ymax] = in_bbox;

  const in_pixel_height = (in_ymax - in_ymin) / in_height;
  const in_pixel_width = (in_xmax - in_xmin) / in_width;
  if (debug_level) console.log("[geowarp] pixel height of source data:", in_pixel_height);
  if (debug_level) console.log("[geowarp] pixel width of source data:", in_pixel_width);

  const [out_xmin, out_ymin, out_xmax, out_ymax] = out_bbox;

  const out_pixel_height = (out_ymax - out_ymin) / out_height;
  const out_pixel_width = (out_xmax - out_xmin) / out_width;

  // iterate over pixels in the out box
  const rows = [];
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
      // console.log({bbox});
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
        const values = [];
        for (let y = topSample; y <= bottomSample; y++) {
          const start = y * in_width;
          for (let x = leftSample; x <= rightSample; x++) {
            // assuming flattened data by band
            const value = band[start + x];
            values.push(value);
          }
        }

        let pixelBandValue = null;
        if (method === "max") {
          pixelBandValue = max(values, in_no_data, out_no_data);
        } else if (method === "mean") {
          pixelBandValue = mean(values, in_no_data, out_no_data);
        } else if (method === "median") {
          pixelBandValue = median(values, in_no_data, out_no_data);
        } else if (method === "min") {
          pixelBandValue = min(values, in_no_data, out_no_data);
        } else if (method.startsWith("mode")) {
          const modes = mode(values);
          const len = modes.length;
          if (len === 1) {
            pixelBandValue = modes[0];
          } else {
            if (method === "mode") {
              pixelBandValue = modes[0];
            } else if (method === "mode-max") {
              pixelBandValue = max(values);
            } else if (method === "mode-mean") {
              pixelBandValue = mean(values);
            } else if (method === "mode-median") {
              pixelBandValue = median(values);
            } else if (method === "mode-min") {
              pixelBandValue = min(values);
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

  if (debug_level) console.log("[geowarp] finishing");
  return { data: rows };
};

if (typeof module === "object") module.exports = geowarp;
if (typeof window === "object") window.geowarp = geowarp;
if (typeof self === "object") self.geowarp = geowarp;

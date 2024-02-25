const { booleanIntersects, calc: getBoundingBox, intersect, polygon } = require("bbox-fns");
const dufour_peyton_intersection = require("dufour-peyton-intersection");
const fastMax = require("fast-max");
const fastMin = require("fast-min");
const Geotransform = require("geoaffine/Geotransform.js");
const getDepth = require("get-depth");
const getTheoreticalMax = require("typed-array-ranges/get-max");
const getTheoreticalMin = require("typed-array-ranges/get-min");
const calcMedian = require("mediana").calculate;
const reprojectBoundingBox = require("bbox-fns/reproject.js");
const reprojectGeoJSON = require("reproject-geojson/pluggable");
const { turbocharge } = require("proj-turbo");
const quickResolve = require("quick-resolve");
const segflip = require("segflip");
const xdim = require("xdim");

// l = console.log;

const clamp = (n, min, max) => (n < min ? min : n > max ? max : n);

const isInvalid = n => n === undefined || n === null || n !== n;

const scaleInteger = (n, r) => {
  const n2 = Math.round(n * r);
  return [n2, n2 / n, n / n2];
};

// result as [xmin, ymin, xmax, ymax]
// for (let column = xmin; column < xmax; column++)
const scalePixel = ([column, row], [x_scale, y_scale]) => [
  Math.round(column * x_scale),
  Math.round(row * y_scale),
  Math.round((column + 1) * x_scale),
  Math.round((row + 1) * y_scale)
];

const uniq = arr => Array.from(new Set(arr)).sort((a, b) => b - a);

const range = ct => new Array(ct).fill(0).map((_, i) => i);

const forEach = (nums, no_data, cb) => {
  const len = nums.length;
  if (no_data) {
    for (let i = 0; i < len; i++) {
      const n = nums[i];
      if (no_data.indexOf(n) === -1) cb(n);
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
      if (typeof n === "number" && n === n && no_data.indexOf(n) === -1) {
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

// returns [functionCached, clearCache]
const cacheFunction = (f, str = it => it.toString()) => {
  let cache = {};
  return [xy => (cache[str(xy)] ??= f(xy)), () => (cache = {})];
};

// generate a histogram from evenly spaced sample points
// purpose is to give us a sense of the distribution of pixel values
// without spending a lot of time reading every point
const quickHistogram = ({ select, width, height }, [across, down]) => {
  const hist = {};
  const x_scale = width / across;
  const y_scale = height / down;
  const rows = new Array(down).fill(null).map((_, i) => Math.floor(i * y_scale));
  const cols = new Array(across).fill(null).map((_, i) => Math.floor(i * x_scale));
  rows.forEach(row => {
    cols.forEach(column => {
      const value = select({ row, column });
      if (value in hist) hist[value]++;
      else hist[value] = 1;
    });
  });
  return Object.entries(hist).sort(([apx, act], [bpx, bct]) => Math.sign(bct - act));
};

const geowarp = function geowarp({
  debug_level = 0,
  in_data,
  in_bbox = undefined,
  in_geotransform = undefined, // 6-parameter geotransform, only necessary when in_data is skewed or rotated
  in_layout = "[band][row,column]",
  in_srs,
  in_height,
  in_pixel_depth, // number of input bands
  in_pixel_height, // optional, automatically calculated from in_bbox
  in_pixel_width, // optional, automatically calculated from in_bbox
  in_width,
  in_no_data, // optional, supports one number or an array of unique no data values
  out_array_types, // array of constructor names passed to internal call to xdim's prepareData function
  out_bands, // array of bands to keep and order, default is keeping all the bands in same order
  out_data, // single or multi-dimensional array that geowarp will fill in with the output
  out_pixel_depth, // optional, number of output bands
  out_pixel_height, // optional, automatically calculated from out_bbox
  out_pixel_width, // optional, automatically calculated from out_bbox
  out_bbox = null,
  out_bbox_in_srs, // very optional, output bbox reprojected into the srs of the input
  out_layout,
  out_resolution = [1, 1],
  out_srs,
  out_width = 256,
  out_height = 256,
  out_no_data = null,
  // out_no_data_strategy = "keep",
  method = "median",
  read_bands = undefined, // which bands to read, used in conjunction with expr
  row_start = 0, // which sample row to start writing with
  row_end, // last sample row to write
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
  insert_pixel, // over-ride function that inserts data into output multi-dimensional array
  insert_sample, // over-ride function that inserts each sample into the output multi-dimensional array (calls insert)
  insert_null_strategy = "skip", // whether to insert or skip null values
  skip_no_data_strategy, // skip processing pixels if "any" or "all" values are "no data"
  cache_process = false // whether to try to cache the processing step
  // cache_functions // this really helps if functions are asynchronous and require posting to a web worker
}) {
  if (debug_level >= 1) console.log("[geowarp] starting");
  const start_time = debug_level >= 1 ? performance.now() : 0;

  if (isNaN(out_height)) throw new Error("[geowarp] out_height is NaN");
  if (isNaN(out_width)) throw new Error("[geowarp] out_width is NaN");

  // track pending promises without the memory overhead
  // of holding all the promises in memory
  let pending = 0;

  const [out_height_in_samples, y_resolution, y_scale] = scaleInteger(out_height, out_resolution[1]);
  const [out_width_in_samples, x_resolution, x_scale] = scaleInteger(out_width, out_resolution[0]);

  if (debug_level >= 1) console.log("[geowarp] scaled size:", [out_width_in_samples, out_height_in_samples]);
  if (debug_level >= 1) console.log("[geowarp] resolution:", [x_resolution, y_resolution]);
  if (debug_level >= 1) console.log("[geowarp] scale:", [x_scale, y_scale]);

  const same_srs = in_srs === out_srs;
  if (debug_level >= 1) console.log("[geowarp] input and output srs are the same:", same_srs);

  if (debug_level >= 1) console.log("[geowarp] skip_no_data_strategy:", skip_no_data_strategy);

  // support for deprecated alias of inverse
  inverse ??= arguments[0].reproject;

  // support for deprecated insert
  insert_pixel ??= arguments[0].insert;

  let in_bbox_out_srs, intersect_bbox_in_srs, intersect_bbox_out_srs;

  if (!same_srs) {
    if (!in_bbox) throw new Error("[geowarp] can't reproject without in_bbox");
    if (!out_bbox) {
      if (forward) out_bbox = in_bbox_out_srs = intersect_bbox_out_srs = reprojectBoundingBox(in_bbox, forward, { density: 100 });
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
  // if (out_no_data === null && out_no_data_strategy === "keep") out_no_data = in_no_data;

  if (Array.isArray(in_no_data) === false) {
    if ("in_no_data" in arguments[0]) {
      in_no_data = [in_no_data];
    } else {
      in_no_data = [];
    }
  }
  const primary_in_no_data = in_no_data[0];

  // processing step after we have read the raw pixel values
  let process;
  if (expr) {
    if (round) {
      process = ({ pixel }) => quickResolve(expr({ pixel })).then(pixel => pixel.map(n => Math.round(n)));
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
          return isInvalid(value) || in_no_data.includes(value) ? out_no_data : Math.round(value);
        });
    } else {
      // without rounding
      process = ({ pixel }) =>
        out_bands_to_read_bands.map(iband => {
          const value = pixel[iband];
          return isInvalid(value) || in_no_data.includes(value) ? out_no_data : value;
        });
    }
  }

  let clear_process_cache;
  if (cache_process) {
    // eslint-disable-next-line no-unused-vars
    [process, clear_process_cache] = cacheFunction(process, ({ pixel }) => pixel.toString());
  }

  if (debug_level >= 1) console.log("[geowarp] read_bands:", read_bands);
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

  in_geotransform ??= [in_xmin, in_pixel_width, 0, in_ymax, 0, -1 * in_pixel_height];

  const { forward: in_img_pt_to_srs_pt, inverse: in_srs_pt_to_in_img_pt } = Geotransform(in_geotransform);

  // convert point in output srs to image pixel coordinate in input image
  const out_srs_pt_to_in_img_pt = same_srs ? in_srs_pt_to_in_img_pt : pt => in_srs_pt_to_in_img_pt(inv(pt));

  const [out_xmin, out_ymin, out_xmax, out_ymax] = out_bbox;
  if (debug_level >= 1) console.log("[geowarp] out_xmin:", out_xmin);
  if (debug_level >= 1) console.log("[geowarp] out_ymin:", out_ymin);
  if (debug_level >= 1) console.log("[geowarp] out_xmax:", out_xmax);
  if (debug_level >= 1) console.log("[geowarp] out_ymax:", out_ymax);

  out_pixel_height ??= (out_ymax - out_ymin) / out_height;
  out_pixel_width ??= (out_xmax - out_xmin) / out_width;
  if (debug_level >= 1) console.log("[geowarp] out_pixel_height:", out_pixel_height);
  if (debug_level >= 1) console.log("[geowarp] out_pixel_width:", out_pixel_width);

  const out_sample_height = out_pixel_height * y_scale;
  const out_sample_width = out_pixel_width * x_scale;
  if (debug_level >= 1) console.log("[geowarp] out_sample_height:", out_sample_height);
  if (debug_level >= 1) console.log("[geowarp] out_sample_width:", out_sample_width);

  const half_out_sample_height = out_sample_height / 2;
  const half_out_sample_width = out_sample_width / 2;

  // const out_geotransform = [out_xmin, out_pixel_width, 0, out_ymax, 0, -1 * out_pixel_height];
  // const { forward: out_img_pt_to_srs_pt, inverse: out_srs_pt_to_img_pt } = Geotransform(out_geotransform);

  const in_img_pt_to_out_srs_pt = same_srs ? in_img_pt_to_srs_pt : pt => fwd(in_img_pt_to_srs_pt(pt));
  // const in_img_pt_to_out_img_pt = same_srs ? pt => out_srs_pt_to_img_pt(in_img_pt_to_srs_pts(pt)) : pt => out_srs_pt_to_img_pt(fwd(in_img_pt_to_srs_pt(pt)));

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
  let segments_by_row = new Array(out_height_in_samples).fill(0).map(() => []);
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
        threshold: [half_out_sample_width, half_out_sample_height]
      })?.reproject;
    }

    cutline = reprojectGeoJSON(cutline, { reproject: cutline_forward_turbocharged || cutline_forward });
  }

  const out_column_max = out_width_in_samples - 1;
  const full_width_row_segment = [0, out_column_max];
  const full_width_row = [full_width_row_segment];

  if (cutline) {
    const intersections = dufour_peyton_intersection.calculate({
      raster_bbox: out_bbox,
      raster_height: out_height_in_samples,
      raster_width: out_width_in_samples,
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
          return full_width_row;
        } else {
          return segflip({
            segments: segs,
            min: 0,
            max: out_column_max,
            debug: false
          });
        }
      });
    }
  } else {
    for (let row_index = 0; row_index < out_height_in_samples; row_index++) {
      segments_by_row[row_index].push(full_width_row_segment);
    }
  }

  const in_sizes = {
    band: in_pixel_depth,
    row: in_height,
    column: in_width
  };

  const select = xdim.prepareSelect({ data: in_data, layout: in_layout, sizes: in_sizes });

  const selectPixel = ({ row, column }) =>
    read_bands.map(
      band =>
        select({
          point: {
            band,
            row,
            column
          }
        }).value
    );

  const hist = quickHistogram({ select: selectPixel, width: in_width, height: in_height }, [10, 10]);
  const { hits, total } = hist.reduce(
    (acc, [px, ct]) => {
      acc.total += ct;
      acc.hits += ct - 1; // subtracting 1 because the first instance of something won't use the cache
      return acc;
    },
    { hits: 0, total: 0 }
  );
  const predicted_cache_hit_rate = hits / total;

  if (cache_process === undefined || cache_process === null) {
    cache_process = predicted_cache_hit_rate >= 0.85;
  }

  if (typeof insert_pixel !== "function") {
    let update;

    // only works once update is defined later on
    const update_pixel = ({ row, column, pixel }) => {
      pixel.forEach((value, band) => {
        update({
          point: { band, row, column },
          value
        });
      });
    };

    let insert_pixel_sync = ({ pixel, ...rest }) => {
      try {
        out_pixel_depth ??= pixel.length;
        if (debug_level >= 1) console.log("[geowarp] out_pixel_depth:", out_pixel_depth);

        const out_sizes = {
          band: out_pixel_depth,
          row: out_height,
          column: out_width
        };
        if (debug_level >= 1) console.log("[geowarp] out_sizes:", out_sizes);

        out_data ??= xdim.prepareData({
          fill: out_no_data,
          layout: out_layout,
          sizes: out_sizes,
          arrayTypes: out_array_types
        }).data;
        if (debug_level >= 1) console.log("[geowarp] out_data:", typeof out_data);

        update = xdim.prepareUpdate({ data: out_data, layout: out_layout, sizes: out_sizes });
        if (debug_level >= 1) console.log("[geowarp] prepared update function");

        // replace self, so subsequent calls go directly to update_pixel
        insert_pixel_sync = update_pixel;

        update_pixel({ pixel, ...rest });
      } catch (error) {
        console.error("first call to insert_pixel_sync failed:", error);
      }
    };

    insert_pixel = ({ pixel, ...rest }) => {
      pending++;
      quickResolve(pixel).then(px => {
        insert_pixel_sync({ pixel: px, ...rest });
        pending--;
      });
    };
  }

  if (typeof insert_sample !== "function") {
    if (x_resolution === 1 && y_resolution === 1) {
      // we call insert_pixel instead of setting insert_sample = insert_pixel
      // because insert_pixel might have been hot swapped
      insert_sample = params => insert_pixel(params);
    } else {
      insert_sample = ({ row, column, pixel, ...rest }) => {
        const [xmin, ymin, xmax, ymax] = scalePixel([column, row], [x_scale, y_scale]);
        for (let y = ymin; y < ymax; y++) {
          for (let x = xmin; x < xmax; x++) {
            insert_pixel({ row: y, column: x, pixel, ...rest });
          }
        }
      };
    }
  }

  row_end ??= out_height_in_samples;

  if (debug_level >= 1) console.log("[geowarp] method:", method);

  // see if can create direct pixel affine transformation
  // skipping over spatial reference system
  let inverse_pixel = ([c, r]) => {
    const x = out_xmin + c * out_sample_width + half_out_sample_width;
    const y = out_ymax - r * out_sample_height - half_out_sample_height;
    const pt_out_srs = [x, y];
    const pt_in_srs = same_srs ? pt_out_srs : inverse(pt_out_srs);
    const pt_in_img = in_srs_pt_to_in_img_pt(pt_in_srs).map(n => Math.floor(n));
    return pt_in_img;
  };

  if (turbo) {
    const reproject = turbocharge({
      bbox: [0, 0, out_width, out_height],
      debug_level,
      quiet: true,
      reproject: inverse_pixel,
      threshold: [0.5, 0.5]
    })?.reproject;
    if (reproject) inverse_pixel = pt => reproject(pt).map(n => Math.round(n));
  }

  let forward_turbocharged, inverse_turbocharged;
  if (turbo) {
    if (forward) {
      out_bbox_in_srs ??= reprojectBoundingBox(out_bbox, inverse, { density: 100, nan_strategy: "skip" });
      intersect_bbox_in_srs ??= intersect(in_bbox, out_bbox_in_srs);
      forward_turbocharged = turbocharge({
        bbox: intersect_bbox_in_srs,
        debug_level,
        quiet: true,
        reproject: forward,
        threshold: [half_out_sample_width, half_out_sample_height]
      });
    }
    if (inverse) {
      in_bbox_out_srs ??= reprojectBoundingBox(in_bbox, forward, { density: 100 });
      intersect_bbox_out_srs ??= intersect(out_bbox, in_bbox_out_srs);
      inverse_turbocharged = turbocharge({
        bbox: intersect_bbox_out_srs,
        debug_level,
        quiet: true,
        reproject: inverse,
        threshold: [half_out_sample_width, half_out_sample_height]
      });
    }
  }
  if (debug_level >= 2) {
    if (forward_turbocharged) console.log("[geowarp] turbocharged forward");
    if (inverse_turbocharged) console.log("[geowarp] turbocharged inverse");
  }
  const fwd = forward_turbocharged?.reproject || forward;
  const inv = inverse_turbocharged?.reproject || inverse;
  // const [invCached, clearInvCache] = cacheFunction(inv);

  let out_sample_height_in_srs, out_sample_width_in_srs, pixel_height_ratio, pixel_width_ratio;
  if (method === "near-vectorize" || method === "nearest-vectorize") {
    if (debug_level >= 2) console.log('[geowarp] choosing between "near" and "vectorize" for best speed');

    out_bbox_in_srs ??= same_srs ? out_bbox : reprojectBoundingBox(out_bbox, inverse, { density: 100, nan_strategy: "skip" });

    // average of how large each output pixel is in the input spatial reference system
    out_sample_height_in_srs = (out_bbox_in_srs[3] - out_bbox_in_srs[1]) / out_height_in_samples;
    out_sample_width_in_srs = (out_bbox_in_srs[2] - out_bbox_in_srs[0]) / out_width_in_samples;

    pixel_height_ratio = out_sample_height_in_srs / in_pixel_height;
    pixel_width_ratio = out_sample_width_in_srs / in_pixel_width;

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
      ? px => px.some(n => isInvalid(n) || in_no_data.includes(n))
      : skip_no_data_strategy === "all"
        ? px => px.every(n => isInvalid(n) || in_no_data.includes(n))
        : () => false;

  if (method === "vectorize") {
    // const [cfwd, clear_forward_cache] = cacheFunction(fwd);

    // reproject bounding box of output (e.g. a tile) into the spatial reference system of the input data
    // setting nan_strategy to skip trims the box in case the output bbox extends over the bounds of the input projection
    out_bbox_in_srs ??= same_srs ? out_bbox : reprojectBoundingBox(out_bbox, inverse, { density: 100, nan_strategy: "skip" });
    let [left, bottom, right, top] = out_bbox_in_srs;

    out_sample_height_in_srs ??= (top - bottom) / out_height_in_samples;
    if (in_pixel_height < out_sample_height_in_srs) {
      if (debug_level >= 1) {
        console.warn(`[geowarp] normalized height of sample area of ${out_sample_height_in_srs} is larger than input pixel height of ${in_pixel_height}`);
      }
    }

    out_sample_width_in_srs ??= (right - left) / out_width;
    if (in_pixel_width < out_sample_width_in_srs) {
      if (debug_level >= 1) {
        console.warn(`[geowarp] normalized width of sample area of ${out_sample_width_in_srs} is larger than input pixel width of ${in_pixel_width}`);
      }
    }

    // if have a cutline do additional clamping
    const cutline_in_srs = cutline && reprojectGeoJSON(cutline, { reproject: inverse });

    // in the future we might want to pull the function getBoundingBox into its own repo
    const cutline_bbox_in_srs = cutline && getBoundingBox(cutline_in_srs);

    if (!cutline || booleanIntersects(in_bbox, cutline_bbox_in_srs)) {
      // update bounding box we sample from based on extent of cutline
      [left, bottom, right, top] = cutline && cutline_strategy !== "inside" ? intersect(out_bbox_in_srs, cutline_bbox_in_srs) : out_bbox_in_srs;
      if (debug_level >= 1) console.log("[geowarp] [left, bottom, right, top]:", [left, bottom, right, top]);

      if ((left < in_xmax && bottom < in_ymax && right > in_xmin) || top < in_ymin) {
        const out_bbox_in_input_image_coords = reprojectBoundingBox(out_bbox_in_srs, in_srs_pt_to_in_img_pt);
        if (debug_level >= 1) console.log("[geowarp] out_bbox_in_input_image_coords:", out_bbox_in_input_image_coords);

        // need to double check intersection in image space in case of rotation/skew
        if (booleanIntersects(out_bbox_in_input_image_coords, [0, 0, in_width, in_height])) {
          // snap to pixel array inidices
          const [in_column_start, in_row_start, in_column_end, in_row_end] = out_bbox_in_input_image_coords.map(n => Math.floor(n));
          const in_row_start_clamped = clamp(in_row_start, 0, in_height - 1);
          const in_row_end_clamped = clamp(in_row_end, 0, in_height - 1);
          const in_column_start_clamped = clamp(in_column_start, 0, in_width - 1);
          const in_column_end_clamped = clamp(in_column_end, 0, in_width - 1);

          for (let r = in_row_start_clamped; r <= in_row_end_clamped; r++) {
            // if (clear_process_cache) clear_process_cache();
            // clear_forward_cache(); // don't want cache to get too large, so just cache each row
            for (let c = in_column_start_clamped; c <= in_column_end_clamped; c++) {
              const raw_values = read_bands.map(band => select({ point: { band, row: r, column: c } }).value);

              if (should_skip(raw_values)) continue;

              const rect = polygon([c, r, c + 1, r + 1]);

              // to-do: reproject to [I, J] (output image point) because
              // intersection algorithm assumes an unskewed space
              // we'll only have to do this if we want to support rotated/skewed output
              const pixel_geometry_in_out_srs = reprojectGeoJSON(rect, { reproject: in_img_pt_to_out_srs_pt });

              const intersect_options = {
                debug: false,
                raster_bbox: out_bbox,
                raster_height: out_height_in_samples,
                raster_width: out_width_in_samples,
                geometry: pixel_geometry_in_out_srs
              };

              // apply band math expression, no-data mapping, and rounding when applicable
              const pixel = process({ pixel: raw_values });

              if (pixel !== null || insert_null_strategy === "insert") {
                if (cutline) {
                  intersect_options.per_pixel = ({ row, column }) => {
                    if (segments_by_row[row].some(([start, end]) => column >= start && column <= end)) {
                      insert_sample({ raw: raw_values, pixel, row, column });
                    }
                  };
                } else {
                  intersect_options.per_pixel = ({ row, column }) => {
                    insert_sample({ raw: raw_values, pixel, row, column });
                  };
                }
                dufour_peyton_intersection.calculate(intersect_options);
              }
            }
          }
        }
      }
    }
  } else if (method === "near" || method === "nearest") {
    const rmax = Math.min(row_end, out_height_in_samples);
    for (let r = row_start; r < rmax; r++) {
      // if (clear_process_cache) clear_process_cache();
      const segments = segments_by_row[r];
      for (let iseg = 0; iseg < segments.length; iseg++) {
        const [cstart, cend] = segments[iseg];
        for (let c = cstart; c <= cend; c++) {
          const [x_in_raster_pixels, y_in_raster_pixels] = inverse_pixel([c, r]);

          let raw_values = [];

          if (x_in_raster_pixels < 0 || y_in_raster_pixels < 0 || x_in_raster_pixels >= in_width || y_in_raster_pixels >= in_height) {
            // through reprojection, we can sometimes find ourselves just across the edge
            raw_values = new Array(read_bands.length).fill(primary_in_no_data);
          } else {
            raw_values = selectPixel({
              row: y_in_raster_pixels,
              column: x_in_raster_pixels
            });
          }

          if (should_skip(raw_values)) continue;
          const pixel = process({ pixel: raw_values });
          if (pixel !== null || insert_null_strategy === "insert") {
            insert_sample({
              row: r,
              column: c,
              pixel,
              raw: raw_values,
              x_in_raster_pixels,
              y_in_raster_pixels
            });
          }
        }
      }
    }
  } else if (method === "bilinear") {
    // see https://en.wikipedia.org/wiki/Bilinear_interpolation

    const rmax = Math.min(row_end, out_height_in_samples);

    let y = out_ymax + half_out_sample_height - row_start * out_sample_height;
    for (let r = row_start; r < rmax; r++) {
      // if (clear_process_cache) clear_process_cache();
      y -= out_sample_height;
      const segments = segments_by_row[r];
      for (let iseg = 0; iseg < segments.length; iseg++) {
        const [cstart, cend] = segments[iseg];
        for (let c = cstart; c <= cend; c++) {
          const x = out_xmin + c * out_sample_width + half_out_sample_width;
          const pt_out_srs = [x, y];
          const pt_in_srs = same_srs ? pt_out_srs : inv(pt_out_srs);
          const [xInRasterPixels, yInRasterPixels] = in_srs_pt_to_in_img_pt(pt_in_srs);

          const left = Math.floor(xInRasterPixels);
          const right = Math.ceil(xInRasterPixels);
          const top = Math.floor(yInRasterPixels);
          const bottom = Math.ceil(yInRasterPixels);

          // if xInRaster pixels is an integer,
          // then leftWeight and rightWeight will equal zero
          // that's not a problem though, because we ignore
          // the weighting when values on each side are the same
          const leftWeight = right - xInRasterPixels;
          const rightWeight = xInRasterPixels - left;
          const topWeight = top === bottom ? 0.5 : bottom - yInRasterPixels;
          const bottomWeight = top === bottom ? 0.5 : yInRasterPixels - top;

          const leftOutside = left < 0 || left >= in_width;
          const rightOutside = right < 0 || right >= in_width;
          const topOutside = top < 0 || top >= in_height;
          const bottomOutside = bottom < 0 || bottom >= in_height;

          const upperleftOutside = topOutside || leftOutside;
          const upperRightOutside = topOutside || rightOutside;
          const lowerleftOutside = bottomOutside || leftOutside;
          const lowerRightOutside = bottomOutside || rightOutside;

          const raw_values = new Array();
          for (let i = 0; i < read_bands.length; i++) {
            const read_band = read_bands[i];

            const upperLeftValue = upperleftOutside ? primary_in_no_data : select({ point: { band: read_band, row: top, column: left } }).value;
            const upperRightValue = upperRightOutside ? primary_in_no_data : select({ point: { band: read_band, row: top, column: right } }).value;
            const lowerLeftValue = lowerleftOutside ? primary_in_no_data : select({ point: { band: read_band, row: bottom, column: left } }).value;
            const lowerRightValue = lowerRightOutside ? primary_in_no_data : select({ point: { band: read_band, row: bottom, column: right } }).value;

            let topValue;
            const upperLeftInvalid = isInvalid(upperLeftValue) || in_no_data.includes(upperLeftValue);
            const upperRightInvalid = isInvalid(upperRightValue) || in_no_data.includes(upperRightValue);
            if (upperLeftInvalid && upperRightInvalid) {
              // keep topValue undefined
            } else if (upperLeftInvalid) {
              topValue = upperRightValue;
            } else if (upperRightInvalid) {
              topValue = upperLeftValue;
            } else if (upperLeftValue === upperRightValue) {
              // because the upper-left and upper-right values are the same, no weighting is necessary
              topValue = upperLeftValue;
            } else {
              topValue = leftWeight * upperLeftValue + rightWeight * upperRightValue;
            }

            let bottomValue;
            const lowerLeftInvalid = isInvalid(lowerLeftValue) || in_no_data.includes(lowerLeftValue);
            const lowerRightInvalid = isInvalid(lowerRightValue) || in_no_data.includes(lowerRightValue);
            if (lowerLeftInvalid && lowerRightInvalid) {
              // keep bottom value undefined
            } else if (lowerLeftInvalid) {
              bottomValue = lowerRightValue;
            } else if (lowerRightInvalid) {
              bottomValue = lowerLeftValue;
            } else if (lowerLeftValue === lowerRightValue) {
              // because the lower-left and lower-right values are the same, no weighting is necessary
              bottomValue = lowerLeftValue;
            } else {
              bottomValue = leftWeight * lowerLeftValue + rightWeight * lowerRightValue;
            }

            let value;
            if (topValue === undefined && bottomValue === undefined) {
              value = primary_in_no_data;
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
          if (pixel !== null || insert_null_strategy === "insert") {
            insert_sample({ row: r, column: c, pixel, raw: raw_values });
          }
        }
      }
    }
  } else {
    // Q: why don't we pass no_data to the following statistical methods (e.g. fastMax)?
    // A: we are already filtering out invalid and no-data values beforehand
    let calc;
    if (typeof method === "function") {
      calc = values => method({ values });
    } else if (method === "max") {
      calc = values => fastMax(values, { theoretical_max });
    } else if (method === "mean") {
      calc = values => mean(values);
    } else if (method === "median") {
      calc = values => calcMedian(values);
    } else if (method === "min") {
      calc = values => fastMin(values, { theoretical_min });
    } else if (method === "mode") {
      calc = values => mode(values)[0];
    } else if (method === "mode-max") {
      calc = values => fastMax(mode(values));
    } else if (method === "mode-mean") {
      calc = values => mean(mode(values));
    } else if (method === "mode-median") {
      calc = values => calcMedian(mode(values));
    } else if (method === "mode-min") {
      calc = values => fastMin(mode(values));
    } else {
      throw new Error(`[geowarp] unknown method "${method}"`);
    }

    let top, left, bottom, right;
    bottom = out_ymax - row_start * row_start;
    const rmax = Math.min(row_end, out_height_in_samples);
    for (let r = row_start; r < rmax; r++) {
      // if (clear_process_cache) clear_process_cache();
      top = bottom;
      bottom = top - out_sample_height;
      const segments = segments_by_row[r];
      for (let iseg = 0; iseg < segments.length; iseg++) {
        const [cstart, cend] = segments[iseg];
        right = out_xmin + out_sample_width * cstart;
        for (let c = cstart; c <= cend; c++) {
          left = right;
          right = left + out_sample_width;
          // top, left, bottom, right is the sample area in the coordinate system of the output

          // convert bbox in output srs to image px of input
          // combing srs reprojection and srs-to-image mapping, ensures that bounding box corners
          // are reprojected fully before calculating containing bbox
          // (prevents drift in increasing bbox twice if image is warped)
          let leftInRasterPixels, topInRasterPixels, rightInRasterPixels, bottomInRasterPixels;
          try {
            [leftInRasterPixels, topInRasterPixels, rightInRasterPixels, bottomInRasterPixels] = reprojectBoundingBox(
              [left, bottom, right, top],
              out_srs_pt_to_in_img_pt,
              { nan_strategy: "throw" }
            );
          } catch (error) {
            // if only one pixel (or row of pixels) extends over the edge of the projection's bounds, we probably don't want to fail the whole thing
            // an example would be warping the globe from 3857 to 4326
            continue;
          }
          if (debug_level >= 4) console.log("[geowarp] leftInRasterPixels:", leftInRasterPixels);
          if (debug_level >= 4) console.log("[geowarp] rightInRasterPixels:", rightInRasterPixels);
          if (debug_level >= 4) console.log("[geowarp] topInRasterPixels:", topInRasterPixels);
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
            raw_values = new Array(read_bands.length).fill(primary_in_no_data);
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
              const valid_values = values.filter(v => typeof v === "number" && v === v && in_no_data.indexOf(v) === -1);
              if (valid_values.length === 0) {
                raw_values.push(primary_in_no_data);
              } else {
                raw_values.push(calc(valid_values));
              }
            }
          }

          if (should_skip(raw_values)) continue;
          const pixel = process({ pixel: raw_values });
          if (pixel !== null || insert_null_strategy === "insert") {
            insert_sample({ row: r, column: c, pixel, raw: raw_values });
          }
        }
      }
    }
  }

  const generate_result = () => {
    if (debug_level >= 1) console.log("[geowarp] took " + (performance.now() - start_time).toFixed(0) + "ms");
    return {
      data: out_data,
      out_bands,
      out_height,
      out_layout,
      out_pixel_depth,
      out_pixel_height,
      out_pixel_width,
      out_sample_height,
      out_sample_width,
      out_width,
      read_bands
    };
  };

  if (pending > 0) {
    // async return
    return new Promise(resolve => {
      const ms = 5; // re-check every 5 milliseconds
      const intervalId = setInterval(() => {
        if (pending === 0) {
          clearInterval(intervalId);
          resolve(generate_result());
        }
      }, ms);
    });
  } else {
    // sync return
    return generate_result();
  }
};

if (typeof module === "object") {
  module.exports = geowarp;
  module.exports.default = geowarp;
}
if (typeof window === "object") window.geowarp = geowarp;
if (typeof self === "object") self.geowarp = geowarp;

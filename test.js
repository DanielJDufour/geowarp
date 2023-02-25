const fs = require("fs");
const findAndRead = require("find-and-read");
const path = require("path");

const count = require("fast-counter");
const test = require("flug");
const GeoTIFF = require("geotiff");
const readBoundingBox = require("geotiff-read-bbox");
const proj4 = require("proj4-fully-loaded");
const reprojectBoundingBox = require("reproject-bbox");
const tilebelt = require("@mapbox/tilebelt");
const { getPalette } = require("geotiff-palette");
const xdim = require("xdim");
const writeImage = require("write-image");

const geowarp = require("./geowarp");

const range = ct => new Array(ct).fill(0).map((_, i) => i);

const exit = process.exit;

const writePNGSync = ({ h, w, data, filepath }) => {
  const { data: buf } = writeImage({ data, height: h, format: "PNG", width: w });
  fs.writeFileSync(`${filepath}.png`, buf);
};

["vectorize", "near", "median", "bilinear"].forEach(method => {
  ["inside", "outside"].forEach(cutline_strategy => {
    test("cutline " + cutline_strategy + " " + method, async ({ eq }) => {
      // console.log("starting:", "cutline " + cutline_strategy + " " + method);
      const cutline = JSON.parse(findAndRead("sri-lanka-hi-res.geojson", { encoding: "utf-8" }));
      const filename = "gadas.tif";
      const filepath = path.resolve(__dirname, "./test-data", filename);
      const geotiff = await GeoTIFF.fromFile(filepath);
      const image = await geotiff.getImage(0);
      const rasters = await image.readRasters();
      const in_bbox = image.getBoundingBox();
      const height = image.getHeight();
      const width = image.getWidth();
      // ProjectedCSTypeGeoKey says 32767, but PCSCitationGeoKey says ESRI PE String = 3857.esriwkt
      const in_srs = 3857;
      const out_srs = "EPSG:5234"; // Kandawala / Sri Lanka Grid
      const { forward, inverse } = proj4("EPSG:" + in_srs, out_srs);

      const { data } = geowarp({
        debug_level: 0,
        in_bbox,
        in_data: rasters,
        in_layout: "[band][row,column]",
        in_srs,
        in_height: height,
        in_width: width,
        out_array_types: ["Array", "Array", "Uint8ClampedArray"],
        out_height: height,
        out_width: width,
        out_layout: "[band][row][column]",
        out_srs,
        forward,
        inverse,
        cutline,
        cutline_srs: 4326,
        cutline_forward: proj4("EPSG:4326", out_srs).forward,
        cutline_strategy,
        method
      });

      if (process.env.WRITE) {
        writePNGSync({ h: height, w: width, data, filepath: `./test-output/gadas-cutline-${cutline_strategy}-${method}` });
      }
      eq(data.length, 4); // check band count
      eq(data[0][0].constructor.name, "Uint8ClampedArray");
    });
  });
});

test("reproject without clipping", async ({ eq }) => {
  const filename = "wildfires.tiff";
  const filepath = path.resolve(__dirname, "./test-data", filename);
  const geotiff = await GeoTIFF.fromFile(filepath);
  const image = await geotiff.getImage(0);
  const geoKeys = image.getGeoKeys();
  const { GeographicTypeGeoKey, ProjectedCSTypeGeoKey } = geoKeys;
  const rasters = await image.readRasters();
  const height = image.getHeight();
  const width = image.getWidth();
  const in_srs = ProjectedCSTypeGeoKey || GeographicTypeGeoKey;
  const [xmin, ymax] = image.getOrigin();
  const [resolutionX, resolutionY] = image.getResolution();
  const ymin = ymax - height * Math.abs(resolutionY);
  const xmax = xmin + width * Math.abs(resolutionX);
  const in_bbox = [xmin, ymin, xmax, ymax];
  const out_srs = "EPSG:26910"; // NAD83 / UTM zone 10N
  const { forward, inverse } = proj4("EPSG:" + in_srs, out_srs);
  const { data } = geowarp({
    in_bbox,
    in_data: rasters,
    in_layout: "[band][row,column]",
    in_srs,
    in_height: height,
    in_width: width,
    out_height: height,
    out_width: width,
    out_layout: "[band][row][column]",
    out_srs,
    forward,
    inverse
  });

  if (process.env.WRITE) {
    writePNGSync({ h: height, w: width, data, filepath: "./test-output/reproject-without-clipping.tif" });
  }
  eq(data.length, 3); // check band count
});

test("bug: reprojecting to EPSG:26910", async ({ eq }) => {
  const filename = "wildfires.tiff";
  const filepath = path.resolve(__dirname, "./test-data", filename);
  const geotiff = await GeoTIFF.fromFile(filepath);
  const image = await geotiff.getImage(0);
  const geoKeys = image.getGeoKeys();
  const { GeographicTypeGeoKey, ProjectedCSTypeGeoKey } = geoKeys;
  const rasters = await image.readRasters();
  const height = image.getHeight();
  const width = image.getWidth();
  const in_srs = ProjectedCSTypeGeoKey || GeographicTypeGeoKey;
  const [xmin, ymax] = image.getOrigin();
  const [resolutionX, resolutionY] = image.getResolution();
  const ymin = ymax - height * Math.abs(resolutionY);
  const xmax = xmin + width * Math.abs(resolutionX);
  const in_bbox = [xmin, ymin, xmax, ymax];
  const out_srs = 26910; // NAD83 / UTM zone 10N
  const factor = 0.05;
  let out_bbox = reprojectBoundingBox({ bbox: [xmin, ymin, xmax, ymax], from: in_srs, to: out_srs });
  // change out_bbox to top left quarter
  out_bbox = [
    out_bbox[0],
    Math.round(out_bbox[3] - (out_bbox[3] - out_bbox[1]) * factor),
    Math.round(out_bbox[0] + (out_bbox[2] - out_bbox[0]) * factor),
    out_bbox[3]
  ];
  const { inverse } = proj4("EPSG:" + in_srs, "EPSG:" + out_srs);
  const { data } = geowarp({
    in_bbox,
    in_data: rasters,
    in_layout: "[band][row,column]",
    in_srs,
    in_height: height,
    in_width: width,
    out_bbox,
    out_height: height,
    out_width: width,
    out_layout: "[band][row][column]",
    out_srs,
    inverse
  });

  if (process.env.WRITE) {
    const filepath = "./test-output/wildfires-26910";
    writePNGSync({ h: height, w: width, data, filepath });
    console.log("wrote:", filepath);
  }
  eq(data.length, 3); // check band count
});

const tileCache = {};

const readTile = async ({ x, y, z, filename }) => {
  const key = JSON.stringify({ x, y, z, filename });
  if (!tileCache[key]) {
    const filepath = path.resolve(__dirname, "./test-data", filename);
    const bbox4326 = tilebelt.tileToBBOX([x, y, z]);
    const bbox3857 = reprojectBoundingBox({ bbox: bbox4326, from: 4326, to: 3857 });
    const geotiff = await GeoTIFF.fromFile(filepath);
    const { data, read_bbox, height, width, srs_of_geotiff } = await readBoundingBox({
      bbox: bbox3857,
      geotiff,
      srs: 3857
    });
    tileCache[key] = {
      data,
      depth: data.length, // num bands
      geotiff_srs: srs_of_geotiff,
      height,
      layout: "[band][row,column]",
      tile_bbox: bbox3857,
      geotiff_bbox: read_bbox,
      width
    };
  }
  return tileCache[key];
};

const runTileTests = async ({
  x,
  y,
  z,
  filename,
  methods,
  out_bands_array,
  out_layouts = ["[row][column][band]", "[band][row][column]", "[band][row,column]"],
  sizes = [64, 256, 512],
  most_common_pixels,
  turbos = [false, true]
}) => {
  try {
    let readTilePromise;
    sizes.forEach(size => {
      methods.forEach(method => {
        out_layouts.forEach(out_layout => {
          out_bands_array.forEach(out_bands => {
            turbos.forEach(turbo => {
              const testName = `${filename.split(".")[0]}-${method}-${size}-${out_layout}-${out_bands}${turbo ? "-turbo" : ""}`;
              test(testName, async ({ eq }) => {
                if (!readTilePromise) readTilePromise = readTile({ x, y, z, filename });

                const info = await readTilePromise;
                // console.log("info got", info);

                const in_srs = info.geotiff_srs;

                const { forward, inverse } = proj4("EPSG:" + in_srs, "EPSG:" + 3857);

                const result = geowarp({
                  debug_level: 0,
                  forward,
                  inverse,

                  // regarding input data
                  in_data: info.data,
                  in_bbox: info.geotiff_bbox,
                  in_layout: info.layout,
                  in_srs: info.geotiff_srs,
                  in_width: info.width,
                  in_height: info.height,

                  // regarding location to paint
                  out_bands,
                  out_bbox: info.tile_bbox,
                  out_layout,
                  out_srs: 3857,
                  out_height: size,
                  out_width: size,
                  method: method === "first" ? ({ values }) => values[0] : method,
                  round: true,
                  turbo
                });

                if (process.env.WRITE) {
                  writePNGSync({ h: size, w: size, data: result.data, filepath: `./test-output/${testName}` });
                }

                eq(result.read_bands, out_bands || range(info.depth));

                let counts;
                if (out_layout === "[row][column][band]") {
                  eq(result.data.length, size);
                  eq(result.data[0].length, size);
                  eq(result.data[0][0].length, out_bands?.length ?? 3);
                  counts = count(result.data, { depth: 2 });
                  const sortedCounts = Object.entries(counts).sort((a, b) => Math.sign(b[1] - a[1]));
                  const top = sortedCounts[0][0];
                  if (method !== "first" && !out_bands) {
                    try {
                      eq(most_common_pixels.includes(top), true);
                    } catch (error) {
                      console.dir(result.data, { depth: 5, maxArrayLength: 5 });
                      console.log("sortedCounts:", sortedCounts.slice(0, 5), "...");
                      console.error(top);
                      throw error;
                    }
                  }
                } else if (out_layout === "[band][row][column]") {
                  eq(result.data.length, out_bands?.length ?? 3);
                  eq(result.data[0].length, size);
                  eq(result.data[0][0].length, size);
                } else if (out_layout === "[band][row,column]") {
                  eq(result.data.length, out_bands?.length ?? 3);
                  eq(
                    result.data.every(b => b.length === size * size),
                    true
                  );
                  counts = count(result.data, { depth: 1 });
                } else if (out_layout === "[row,column,band]") {
                  eq(result.data.length, 3 * size * size);
                  eq(
                    result.data.every(n => typeof n === "number"),
                    true
                  );
                }
              });
            });
          });
        });
      });
    });
  } catch (error) {
    console.error(error);
    exit();
  }
};

[
  {
    x: 40,
    y: 96,
    z: 8,
    sizes: [64, 256, 512],
    filename: "wildfires.tiff",
    methods: ["first", "bilinear", "near", "max", "mean", "median", "min", "mode", "mode-mean", "mode-max", "mode-min"],
    out_bands_array: [undefined, [0], [2, 1, 0]],
    most_common_pixels: [
      "0,0,0",
      "11,16,7",
      "11,16,8",
      "15,23,10",
      "16,24,11",
      "17,25,12",
      "17,25,14",
      "18,26,11",
      "18,26,12",
      "19,27,12",
      "20,28,13",
      "21,29,14",
      "13,18,9",
      "19,25,13",
      "22,30,17",
      "23,31,18"
    ]
  },
  {
    x: 3853,
    y: 6815,
    z: 14,
    sizes: [64, 256, 512],
    filename: "SkySat_Freeport_s03_20170831T162740Z3.tif",
    methods: ["first", "bilinear", "near", "max", "mean", "median", "min", "mode", "mode-mean", "mode-max", "mode-min"],
    out_bands_array: [undefined, [0], [2, 1, 0]],
    most_common_pixels: [
      "104,89,75",
      "105,90,76",
      "106,90,77",
      "107,90,77",
      "108,91,77",
      "121,110,99",
      "128,124,122",
      "132,127,125",
      "136,130,128",
      "136,133,139",
      "139,132,128",
      "140,133,129",
      "141,134,131",
      "142,135,131",
      "142,135,132",
      "142,136,132",
      "143,136,133",
      "143,137,132",
      "146,133,139",
      "146,140,135",
      "146,140,137",
      "146,141,139",
      "147,133,139",
      "147,140,136",
      "147,140,137",
      "147,141,137",
      "147,141,139",
      "150,144,142",
      "152,146,142",
      "152,146,143",
      "153,133,143",
      "154,147,144",
      "157,133,139",
      "157,152,150",
      "208,205,204",
      "208,204,204"
    ]
  }
].forEach(runTileTests);

["bilinear", "near", "min", "max", "median", "vectorize"].forEach(method => {
  test(method + " performance", async ({ eq }) => {
    const info = await readTile({ x: 3853, y: 6815, z: 14, filename: "SkySat_Freeport_s03_20170831T162740Z3.tif" });

    const { forward, inverse } = proj4("EPSG:" + info.geotiff_srs, "EPSG:" + 3857);
    const result = geowarp({
      debug_level: 0,
      forward,
      inverse,

      // regarding input data
      in_data: info.data,
      in_bbox: info.geotiff_bbox,
      in_srs: info.geotiff_srs,
      in_width: info.width,
      in_height: info.height,

      // regarding location to paint
      out_bbox: info.tile_bbox,
      out_layout: "[row][column][band]",
      out_srs: 3857,
      out_height: 256,
      out_width: 256,
      method,
      round: true
    });

    if (process.env.WRITE) {
      writePNGSync({ h: 256, w: 256, data: result.data, filepath: "./test-output/" + method + "-performance" });
    }
  });
});

["bilinear", "near", "min", "max", "median"].forEach(method => {
  test("expr " + method, async ({ eq }) => {
    const info = await readTile({ x: 3853, y: 6815, z: 14, filename: "SkySat_Freeport_s03_20170831T162740Z3.tif" });

    const result = geowarp({
      debug_level: 0,
      // rescale and add alpha channel
      read_bands: [0, 1], // only read the first two bands
      expr: ({ pixel }) => pixel.map(v => v / 255).concat([0, 1]),
      reproject: proj4("EPSG:" + 3857, "EPSG:" + info.geotiff_srs).forward,

      // regarding input data
      in_data: info.data,
      in_bbox: info.geotiff_bbox,
      in_srs: info.geotiff_srs,
      in_width: info.width,
      in_height: info.height,

      // regarding location to paint
      out_bbox: info.tile_bbox,
      out_layout: "[row,column,band]",
      out_pixel_depth: 4,
      out_srs: 3857,
      out_height: 256,
      out_width: 256,
      method,
      round: true
    });
    eq(
      result.data.every(n => n >= 0 && n <= 1),
      true
    );
    eq(result.read_bands, [0, 1]);
  });
});

test("edge case: web mercator tile from UTM", async ({ eq }) => {
  const filepath = path.resolve(__dirname, "./test-data/utm.tif");
  const geotiff = await GeoTIFF.fromFile(filepath);
  const image = await geotiff.getImage();
  const rasters = await image.readRasters();
  const palette = getPalette(image);
  const in_width = image.getWidth(); // 100
  const in_height = image.getHeight(); // 100

  const in_data = xdim.transform({
    data: rasters,
    from: "[band][row,column]",
    to: "[band][row][column]",
    sizes: {
      band: 1,
      row: in_height,
      column: in_width
    }
  }).data;
  const in_srs = 32617;
  const out_srs = 3857;

  const { inverse, forward } = proj4("EPSG:" + in_srs, "EPSG:" + out_srs);

  // tile x: 1152, y: 1535, z: 12,
  const out_bbox = [-8766409.899970293, 5009418.403634399, -8756625.96034979, 5019161.025317816];
  const out_height = 255;
  const out_width = 256;

  ["vectorize", "near", "bilinear", "median"].forEach(method => {
    console.log("method:", method);
    const options = {
      debug_level: 0,
      inverse,
      forward,

      expr: ({ pixel }) => {
        return palette[pixel[0]] || [0, 0, 0, 0];
      },

      // regarding input data
      in_bbox: image.getBoundingBox(),
      in_data,
      in_layout: "[band][row][column]",
      in_srs,
      in_width,
      in_height,

      // regarding location to paint
      out_array_types: ["Array", "Array", "Array"],
      out_bbox,
      out_layout: "[band][row][column]",
      out_pixel_depth: 4,
      out_srs,
      out_height,
      out_width,
      method,
      round: true
    };

    const warped = geowarp(options);

    if (process.env.WRITE) {
      writePNGSync({ h: out_height, w: out_width, data: warped.data, filepath: "./test-output/edge-case-utm-" + method });
    }
  });
});

test("OpenLandMap", async ({ eq }) => {
  const filepath = path.resolve(__dirname, "./test-data/lcv_landuse.cropland_hyde_p_10km_s0..0cm_2016_v3.2.tif");
  const geotiff = await GeoTIFF.fromFile(filepath);
  const image = await geotiff.getImage();
  const rasters = await image.readRasters();
  const in_width = image.getWidth();
  const in_height = image.getHeight();

  const in_data = xdim.transform({
    data: rasters,
    from: "[band][row,column]",
    to: "[band][row][column]",
    sizes: {
      band: 1,
      row: in_height,
      column: in_width
    }
  }).data;
  const in_srs = 4326;
  const out_srs = 3857;

  const { inverse, forward } = proj4("EPSG:" + in_srs, "EPSG:" + out_srs);

  // tile x: 1152, y: 1535, z: 12,
  const tile_bbox = require("@mapbox/tilebelt").tileToBBOX([0, 0, 1]);
  const out_bbox = reprojectBoundingBox({ bbox: tile_bbox, from: 4326, to: 3857 });

  console.log({ tile_bbox, out_bbox });
  const out_height = 1;
  const out_width = 1;

  // const methods = ["vectorize", "near", "bilinear", "median"];
  const methods = ["near"];
  methods.forEach(method => {
    console.log("method:", method);
    const options = {
      debug_level: 5,
      inverse,
      forward,

      // regarding input data
      in_bbox: image.getBoundingBox(),
      in_data,
      in_layout: "[band][row][column]",
      in_srs,
      in_width,
      in_height,

      // regarding location to paint
      out_array_types: ["Array", "Array", "Array"],
      out_bbox,
      out_layout: "[band][row][column]",
      out_srs,
      out_height,
      out_width,
      method,
      round: true
    };

    const warped = geowarp(options);

    const value = warped.data[0][0][out_width - 1];
    eq(value !== null, true);
  });
});

test("rescale", async ({ eq }) => {
  const filename = "gadas.tif";
  const filepath = path.resolve(__dirname, "./test-data", filename);
  const geotiff = await GeoTIFF.fromFile(filepath);
  const image = await geotiff.getImage(0);
  const rasters = await image.readRasters();
  const in_bbox = image.getBoundingBox();
  const height = image.getHeight();
  const width = image.getWidth();
  // ProjectedCSTypeGeoKey says 32767, but PCSCitationGeoKey says ESRI PE String = 3857.esriwkt
  const in_srs = 3857;
  const out_srs = 3857;
  const out_height = Math.round(height / 5);
  const out_width = Math.round(width / 5);

  const { data } = geowarp({
    debug_level: 0,
    in_bbox,
    in_data: rasters,
    in_layout: "[band][row,column]",
    in_srs,
    in_height: height,
    in_width: width,
    out_array_types: ["Array", "Array", "Array"],
    out_height,
    out_width,
    out_layout: "[band][row][column]",
    out_srs,
    method: "median"
  });

  if (process.env.WRITE) {
    writePNGSync({ h: out_height, w: out_width, data, filepath: "./test-output/gadas-rescale" });
  }
  eq(data.length, 4); // check band count
  eq(data[0][0].constructor.name, "Array");
});

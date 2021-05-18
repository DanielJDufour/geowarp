const fs = require("fs");
const path = require("path");

const count = require("fast-counter");
const test = require("flug");
const { PNG } = require("pngjs");
const GeoTIFF = require("geotiff");
const readBoundingBox = require("geotiff-read-bbox");
const proj4 = require("proj4-fully-loaded");
const reprojectBoundingBox = require("reproject-bbox");
const tilebelt = require("@mapbox/tilebelt");

const geowarp = require("./geowarp");

const exit = process.exit;

const convertValuesToFrameData = values => {
  const imageHeight = values.length;
  const imageWidth = values[0].length;
  const numBands = values[0][0].length;
  const frameData = Buffer.alloc(imageHeight * imageWidth * 4);
  for (let y = 0; y < imageHeight; y++) {
    for (let x = 0; x < imageWidth; x++) {
      const i = y * imageWidth * 4 + x * 4;
      frameData[i] = values[y][x][0];
      frameData[i + 1] = values[y][x][1];
      frameData[i + 2] = values[y][x][2];
      frameData[i + 3] = numBands === 4 ? values[y][x][3] : 255;
    }
  }
  return frameData;
};

const writePNGSync = ({ h, w, data, filepath }) => {
  const actual = new PNG({ height: h, width: w });
  actual.data = convertValuesToFrameData(data);
  fs.writeFileSync(`${filepath}.png`, PNG.sync.write(actual));
};

const readTile = async ({ x, y, z, filename }) => {
  const filepath = path.resolve(__dirname, "./test-data", filename);
  const bbox4326 = tilebelt.tileToBBOX([x, y, z]);
  const bbox3857 = reprojectBoundingBox({ bbox: bbox4326, from: 4326, to: 3857 });
  const geotiff = await GeoTIFF.fromFile(filepath);
  const { data, read_bbox, height, width, srs_of_geotiff } = await readBoundingBox({
    bbox: bbox3857,
    geotiff,
    srs: 3857,
  });
  return {
    data,
    geotiff_srs: srs_of_geotiff,
    height,
    tile_bbox: bbox3857,
    geotiff_bbox: read_bbox,
    width,
  };
};

const runTileTests = async ({ x, y, z, filename, most_common_pixels }) => {
  try {
    const info = await readTile({ x, y, z, filename });
    // console.log("info got", info);

    const in_srs = info.geotiff_srs;

    const reproject = proj4("EPSG:" + 3857, "EPSG:" + in_srs).forward;

    [64, 256, 512].forEach(size => {
      ["max", "mean", "median", "min", "mode", "mode-mean", "mode-max", "mode-min"].forEach(method => {
        const testName = `${filename.split(".")[0]}-${method}-${size}`;
        test(testName, ({ eq }) => {
          const result = geowarp({
            debug_level: 0,
            reproject,

            // regarding input data
            in_data: info.data,
            in_bbox: info.geotiff_bbox,
            in_srs: info.geotiff_srs,
            in_width: info.width,
            in_height: info.height,

            // regarding location to paint
            out_bbox: info.tile_bbox,
            out_srs: 3857,
            out_height: size,
            out_width: size,
            method,
            round: true,
          });

          eq(result.data.length, size);
          eq(result.data[0].length, size);
          eq(result.data[0][0].length, 3);

          const counts = count(result.data, { depth: 2 });
          const top = Object.entries(counts).sort((a, b) => Math.sign(b - a))[0][0];
          eq(most_common_pixels.includes(top), true);

          // writePNGSync({ h: size, w: size, data: result.data, filepath: `./test-data/${testName}` });
        });
      });
    });
  } catch (error) {
    console.error(error);
    exit();
  }
};

[
  { x: 40, y: 96, z: 8, filename: "wildfires.tiff", most_common_pixels: ["0,0,0", "18,26,12", "13,18,9", "22,30,17"] },
  {
    x: 3853,
    y: 6815,
    z: 14,
    filename: "SkySat_Freeport_s03_20170831T162740Z3.tif",
    most_common_pixels: [
      "121,110,99",
      "132,127,125",
      "139,132,128",
      "140,133,129",
      "142,135,132",
      "143,136,133",
      "143,137,132",
      "146,140,137",
      "146,141,139",
      "147,140,136",
      "147,141,137",
      "152,146,143",
      "153,133,143",
      "157,152,150",
      "208,205,204",
    ],
  },
].forEach(runTileTests);

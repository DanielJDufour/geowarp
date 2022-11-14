// @ts-ignore
import { writeFileSync } from "node:fs";
// @ts-ignore
import findAndRead from "find-and-read";
// @ts-ignore
import { resolve } from "node:path";

import count from "fast-counter";
import test from "flug";
// @ts-ignore
import { fromFile } from "geotiff";
// @ts-ignore
import readBoundingBox from "geotiff-read-bbox";
// @ts-ignore
import proj4 from "proj4-fully-loaded";
import reprojectBoundingBox from "reproject-bbox";
// @ts-ignore
import tilebelt from "@mapbox/tilebelt";
// @ts-ignore
import writeImage from "write-image";

import geowarp from "./geowarp";

const range = (ct: number) => new Array(ct).fill(0).map((_, i) => i);

const exit = (process as any).exit;

const writePNGSync = ({ h, w, data, filepath }: { h: number, w: number, data: any, filepath: string }) => {
  const { data: buf } = writeImage({ data, height: h, format: "PNG", width: w })!;
  writeFileSync(`${filepath}.png`, Buffer.from(buf));
};

["near", "median", "bilinear"].forEach(method => {
  test("cutline " + method, async ({ eq }) => {
    const cutline = JSON.parse(findAndRead("sri-lanka-hi-res.geojson", { encoding: "utf-8" }));
    const filename = "gadas.tif";
    const filepath = resolve(__dirname, "./test-data", filename);
    const geotiff = await fromFile(filepath);
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
      method
    });

    if (process.env.GEOWARP_WRITE_PNG) {
      writePNGSync({ h: height, w: width, data, filepath: `./test-data/gadas-cutline-` + method });
    }
    eq(data.length, 4); // check band count
    eq((data as any)[0][0].constructor.name, "Uint8ClampedArray");
  });
});

test("reproject without clipping", async ({ eq }) => {
  const filename = "wildfires.tiff";
  const filepath = resolve(__dirname, "./test-data", filename);
  const geotiff = await fromFile(filepath);
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

  if (process.env.GEOWARP_WRITE_PNG) {
    writePNGSync({ h: height, w: width, data, filepath: `./test-data/reproject-without-clipping.tif` });
  }
  eq(data.length, 3); // check band count
});

test("bug: reprojecting to EPSG:26910", async ({ eq }) => {
  const filename = "wildfires.tiff";
  const filepath = resolve(__dirname, "./test-data", filename);
  const geotiff = await fromFile(filepath);
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

  if (process.env.GEOWARP_WRITE_PNG) {
    const filepath = "./test-data/wildfires-26910";
    writePNGSync({ h: height, w: width, data, filepath });
    console.log("wrote:", filepath);
  }
  eq(data.length, 3); // check band count
});

const readTile = async ({ x, y, z, filename }: { x: number, y: number, z: number, filename: string }) => {
  const filepath = resolve(__dirname, "./test-data", filename);
  const bbox4326 = tilebelt.tileToBBOX([x, y, z]);
  const bbox3857 = reprojectBoundingBox({ bbox: bbox4326, from: 4326, to: 3857 });
  const geotiff = await fromFile(filepath);
  const { data, read_bbox, height, width, srs_of_geotiff } = await readBoundingBox({
    bbox: bbox3857,
    geotiff,
    srs: 3857
  });
  return {
    data,
    depth: data.length, // num bands
    geotiff_srs: srs_of_geotiff,
    height,
    layout: "[band][row,column]",
    tile_bbox: bbox3857,
    geotiff_bbox: read_bbox,
    width
  };
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
  most_common_pixels
}: {
  x: number,
  y: number,
  z: number,
  filename: string,
  methods: string[],
  out_bands_array: Array<undefined | number[]>,
  out_layouts?: string[],
  sizes: number[],
  most_common_pixels: string[]
}) => {
  try {
    let readTilePromise: ReturnType<typeof readTile> | undefined;
    sizes.forEach((size: number) => {
      methods.forEach((method: string) => {
        out_layouts.forEach((out_layout: string) => {
          out_bands_array.forEach((out_bands: number[] | undefined) => {
            const testName = `${filename.split(".")[0]}-${method}-${size}-${out_layout}-${out_bands}`;
            test(testName, async ({ eq }) => {
              if (!readTilePromise) readTilePromise = readTile({ x, y, z, filename });

              const info = await readTilePromise;
              // console.log("info got", info);

              const in_srs = info.geotiff_srs;

              const reproject = proj4("EPSG:" + 3857, "EPSG:" + in_srs).forward;

              const result = geowarp({
                debug_level: 0,
                inverse: reproject,

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
                round: true
              });

              eq(result.read_bands, out_bands || range(info.depth));

              const result_data = result.data as any;

              let counts: { [key: string]: number } | undefined;
              if (out_layout === "[row][column][band]") {
                eq(result_data.length, size);
                eq(result_data[0].length, size);
                eq(result_data[0][0].length, out_bands?.length ?? 3);
                counts = count(result.data, { depth: 2 });
                const top = Object.entries(counts).sort((a, b) => Math.sign(b[1] - a[1]))[0][0];
                if (method !== "first" && !out_bands) {
                  try {
                    eq(most_common_pixels.includes(top), true);
                  } catch (error) {
                    console.error(top);
                    throw error;
                  }
                }
              } else if (out_layout === "[band][row][column]") {
                eq(result_data.length, out_bands?.length ?? 3);
                eq(result_data[0].length, size);
                eq(result_data[0][0].length, size);
              } else if (out_layout === "[band][row,column]") {
                eq(result_data.length, out_bands?.length ?? 3);
                eq(
                  result_data.every((b: number[]) => b.length === size * size),
                  true
                );
                counts = count(result_data, { depth: 1 });
              } else if (out_layout === "[row,column,band]") {
                eq(result_data.length, 3 * size * size);
                eq(
                  result_data.every((n: number) => typeof n === "number"),
                  true
                );
              }

              if (process.env.GEOWARP_WRITE_PNG) {
                writePNGSync({ h: size, w: size, data: result.data, filepath: `./test-data/${testName}` });
              }
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
    most_common_pixels: ["0,0,0", "11,16,8", "16,24,11", "18,26,11", "18,26,12", "13,18,9", "22,30,17"]
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
      "105,88,75",
      "106,89,75",
      "106,90,77",
      "107,90,76",
      "107,91,79",
      "107,92,79",
      "121,110,99",
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

["bilinear", "near", "min", "max", "median"].forEach(method => {
  test(method + " performance", async ({ eq }) => {
    const info = await readTile({ x: 3853, y: 6815, z: 14, filename: "SkySat_Freeport_s03_20170831T162740Z3.tif" });

    console.time("geowarping");
    const result = geowarp({
      debug_level: 0,
      inverse: proj4("EPSG:" + 3857, "EPSG:" + info.geotiff_srs).forward,

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
    console.timeEnd("geowarping");
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
      inverse: proj4("EPSG:" + 3857, "EPSG:" + info.geotiff_srs).forward,

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
    const result_data = result.data as any;
    eq(
      result_data.every((n: number) => n >= 0 && n <= 1),
      true
    );
    eq(result.read_bands, [0, 1]);
  });
});
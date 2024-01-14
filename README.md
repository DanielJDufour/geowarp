# geowarp
> Super Low-Level Raster Reprojection and Resampling Library

# install
```bash
npm install -S geowarp
```

# usage
```javascript
const geowarp = require("geowarp");
const proj4 = require("proj4-fully-loaded");

const result = geowarp({
  // control the level of console log output
  // set debug_level to zero to turn off console logging
  debug_level: 2,

  // reproject from an [x, y] point in the input spatial reference system
  // to an [x, y] point in the output spatial reference system
  forward: proj4("EPSG:" + in_srs, "EPSG:3857").forward,

  // reproject from an [x, y] point in the output spatial reference system
  // to an [x, y] point in the input spatial reference system
  inverse: proj4("EPSG:" + in_srs, "EPSG:3857").inverse,

  // two-dimensional array of pixel data organized by band
  // usually [ r, g, b ] or [ r, g, b, a ]
  // pixel data for each band is usually flattened,
  // so the end of one row is immediately followed by the next row
  in_data: [
    [0, 123, 123, 162, ...],
    [213, 41, 62, 124, ...],
    [84, 52, 124, 235, ...]
  ],

  // bounding box of input data (in_data)
  // in [xmin, ymin, xmax, ymax] format
  in_bbox: [ -122.51, 40.97, -122.34, 41.11 ],

  // layout of the in_data using xdim layout syntax
  // see: https://github.com/danieljdufour/xdim
  in_layout: "[band][row,column]",

  // a number or array of numbers
  in_no_data: -99,

  // a number or string representing the spatial reference system of the input data
  // could be 4326 or "EPSG:4326"
  in_srs: 4326,

  // only necessary when in_data is skewed or rotated
  // 6-parameter geotransform using the order from https://gdal.org/tutorials/geotransforms_tut.html
  in_geotransform: [337934.48363, -0.142999, -0.576775, 7840518.4648, -0.57677, 0.14299],

  // how many pixels wide the input data is
  in_width: 1032,

  // how many pixels tall the input data is
  in_height: 1015,

  // optional array of constructor names for each array level
  // default is to use Array (untyped) for everything
  out_array_types: ["Array", "Array", "Uint8Array"],

  // optional array for sampling and/or changing band order
  // array is the order of the bands in the output with numbers
  // indicating the band index in the input (starting at zero)
  // for example, [13, 12, 11] skips the first 11 bands,
  // and takes the 12th, 13th, and 14th in reverse order
  out_bands: [13, 12, 11],

  // bounding box of output
  // this is the space that you want to paint
  // in same format as in_bbox
  out_bbox: [-13638811.83098057, 5028944.964938315, -13619243.951739563, 5028944.964938315],

  // optional
  // single or multi-dimensional array that will hold the output
  out_data: [[[[],[],[],...],[[],[],[],...],[[],[],[],...],[[],[],[],...],...]],

  // optional, default is null
  // the no data value for your output data
  out_no_data: -99,

  // layout of the result using xdim layout syntax
  // see: https://github.com/danieljdufour/xdim
  out_layout: "[row][column][band]",

  // a number or string representing the spatial reference system of the input data
  // could be 4326 or "EPSG:4326"
  out_srs: 3857,

  // optional
  // number of bands in the output
  out_pixel_depth: 3,

  // height of the output image in pixels
  out_height: 256,

  // width of the output image in pixels
  out_width: 256,

  // horizontal and vertical resolution
  // resolution of [0.25, 0.25] (i.e. 25%) means that you sample once for every 4 x 4 pixels
  // this is useful if you need your output to be a certain height or width (like 256 x 256)
  // but don't necessarily want to render data at that high resolution
  out_resolution: [0.5, 0.5],

  // method for sampling pixels
  // current supported methods are:
  // "near", "vectorize", "near-vectorize", "bilinear", "max", "mean", "median", "min", "mode", "mode-max", "mode-mean", "mode-median", and "mode-min"
  // you can also pass in a custom function that takes in ({ values }) and returns a number
  method: 'median',

  // round output pixel values to closest integer
  // do this if you will convert your output to a PNG or JPG
  round: true,

  // optional
  // the lowest possible pixel value considering the bit-depth of the data
  // this is used to speed up the min and mode-min resampling
  // if in_data is an array of typed arrays, this will be automatically calculated 
  theoretical_min: 0,

  // optional
  // the highest possible pixel value considering the bit-depth of the data
  // this is used to speed up the max and mode-max resampling
  // if in_data is an array of typed arrays, this will be automatically calculated 
  theoretical_max: 255,

  // optional
  // band math expression that maps a pixel from the read bands to the output
  // if expr is async (i.e. returns a promise), geowarp will return a promise
  expr: ({ pixel }) => {
    // clamp values above 100
    return pixel.map(value => Math.min(value, 100));
  },

  // optional
  // whether to insert or skip null values
  // "skip" - default, don't insert null values
  // "insert" - try to insert null values into output data
  insert_null_strategy: "skip",

  // optional
  // array of band indexes to read from
  // use this if your expr function only uses select bands
  read_bands: [0, 1, 2],
  
  // optional
  // polygon or multi-polygons defining areas to cut out (everything outside becomes no data)
  // terminology taken from https://gdal.org/programs/gdalwarp.html
  cutline: geojson,
  
  // if you specify a cutline, this is required
  cutline_srs: 4326,
  
  // function to reproject [x, y] point from cutline_srs to out_srs
  // required if you specify a cutline and the cutline is a different srs than out_srs,
  cutline_forward: proj4("EPSG:4326", "EPSG:3857").forward,

  // optional, default is "outside"
  // cut out the pixels "inside" or "outside" the cutline
  // in other words, if your cutline_strategy is "inside",
  // geowarp will set every pixel inside your cutline geometry to out_no_data
  cutline_strategy: "inside",

  // optional, default is false
  // enable experimental turbocharging via proj-turbo
  turbo: true,

  // completely optional and not recommended
  // you don't want this in most cases
  // over-ride the default function for inserting data into the output multidimensional array
  // useful if writing to an alternative object like a canvas
  insert_pixel: ({ row, column, pixel }) => {
    context.fillStyle = toColor(pixel);
    context.fillRect(column, row, 1, 1);
  },

  // completely optional and not recommended in most cases
  // take pixel values for a given sample located by sample row and column
  // and insert into the output multidimensional array
  // by default, this will call insert_pixel
  insert_sample: ({ row, column, pixel }) => {
    const [xmin, ymin, xmax, ymax] = scalePixel([column, row], [x_scale, y_scale]);
    for (let y = ymin; y < ymax; y++) {
      for (let x = xmin; x < xmax; x++) {
        insert_pixel({ row: y, column: x, pixel });
      }
    }
  },

  // skip writing a pixel if "any" or "all" its values are no data
  // default is undefined, meaning don't skip no data values
  skip_no_data_strategy: "any"
});
```
result is
```js
{
  // a multi-dimensional array of pixel values with the structure defined by out_layout
  data: [
    [ [...], [...], [...] ], // band 1
    // ...
  ]
}
```

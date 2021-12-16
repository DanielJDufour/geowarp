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

  // a number or string representing the spatial reference system of the input data
  // could be 4326 or "EPSG:4326"
  in_srs: 4326,

  // how many pixels wide the input data is
  in_width: 1032,

  // how many pixels tall the input data is
  in_height: 1015,

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

  // layout of the result using xdim layout syntax
  // see: https://github.com/danieljdufour/xdim
  out_layout: "[row][column][band]",

  // a number or string representing the spatial reference system of the input data
  // could be 4326 or "EPSG:4326"
  out_srs: 3857,

  // number of bands in the output
  // defaults to the number of input bands
  out_pixel_depth: 3,

  // height of the output image in pixels
  out_height: 256,

  // width of the output image in pixels
  out_width: 256,

  // method to use to sample the pixels
  // current supported methods are:
  // "near", "bilinear", "max", "mean", "median", "min", "mode", "mode-max", "mode-mean", "mode-median", and "mode-min"
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
  expr: ({ pixel }) => {
    // clamp values above 100
    return pixel.map(value => Math.min(value, 100));
  },

  // optional
  // array of band indexes to read from
  // use this if your expr function only uses select bands
  read_bands: [0, 1, 2]
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

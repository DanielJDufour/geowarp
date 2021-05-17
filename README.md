# geowarp
Super Low-Level Raster Reprojection and Resampling Library

# install
```bash
npm install -S geowarp
```

# usage
```javascript
const geowarp = require("geowarp");
const geotiff = require("geotiff");
const proj4 = require("proj4-fully-loaded");

// inside an async function
// bounding box in Web Mercator Projection (https://epsg.io/3857)
// here's the same bbox in EPSG 4326 projection: [ -122.51953125, 40.97989806962013, -122.34375, 41.11246878918086 ]
const bbox = [-13638811.83098057, 5028944.964938315, -13619243.951739563, 5028944.964938315];
const tiff = await geotiff.fromUrl("https://geoblaze.s3.amazonaws.com/wildfires.tiff");

const result = geowarp({
  // control the level of console log output
  // set debug_level to zero to turn off console logging
  debug_level: 2,

  // reproject from an [x, y] point in the output spatial reference system
  // to an [x, y] point in the input spatial reference system
  reproject: proj4("EPSG:" + 3857, "EPSG:" + in_srs).forward,

  // two-dimensional array of pixel data organized by band
  // usually [ r, g, b ] or [ r, g, b, a ]
  // pixel data for each band is usually flattened,
  // so the end of one row is immediately followed by the next row
  in_data,

  // bounding box of input data (in_data)
  // in [xmin, ymin, xmax, ymax] format
  // e.g. [ -122.51, 40.97, -122.34, 41.11 ]
  in_bbox,

  // a number or string representing the spatial reference system of the input data
  // could be 4326 or "EPSG:4326"
  in_srs,

  // how many pixels wide the input data is
  in_width: in_data.width,

  // how many pixels tall the input data is
  in_height: in_data.height,

  // bounding box of output
  // this is the space that you want to paint
  // in same format as in_bbox
  // e.g. [ -122.51, 40.97, -122.34, 41.11 ]
  out_bbox,

  // a number or string representing the spatial reference system of the input data
  // could be 4326 or "EPSG:4326"
  out_srs: 3857,

  // height of the output image in pixels
  out_height,

  // width of the output image in pixels
  out_width,

  // method to use to sample the pixels
  // current supported methods are:
  // "max", "mean", "median", "min", "mode", "mode-max", "mode-mean", "mode-median", and "mode-min"
  method,

  // round output pixel values to closest integer
  // do this if you will convert your output to a PNG or JPG
  round: true
});

// result.data is a 3-dimensional array of pixel values broken down by row then column the band
```
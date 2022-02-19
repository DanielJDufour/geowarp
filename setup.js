const fs = require("fs");
const https = require("https");
const path = require("path");

const DATA_DIR = "./test-data";

/* DOWNLOAD DATA */
const download = url => {
  const filename = url.split("/").slice(-1)[0];
  const filepath = path.resolve(DATA_DIR, filename);
  const file = fs.createWriteStream(filepath);
  https.get(url, res => res.pipe(file));
};

// substitute? https://storage.googleapis.com/pdd-stac/disasters/hurricane-harvey/0831/20170831_172754_101c_3b_Visual.tif
download("https://s3-us-west-2.amazonaws.com/planet-disaster-data/hurricane-harvey/SkySat_Freeport_s03_20170831T162740Z3.tif");

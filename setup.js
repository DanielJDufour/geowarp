const fs = require("fs");
const https = require("https");
const path = require("path");

const DATA_DIR = "./test-data";

/* CLEAN TEST DATA FOLDER */
fs.rmdirSync(DATA_DIR, { force: true, recursive: true });
console.log("cleaned " + DATA_DIR);

/* ADD TEST DATA FOLDER */
fs.mkdirSync(DATA_DIR);
console.log("added " + DATA_DIR);

/* DOWNLOAD DATA */
const download = url => {
  const filename = url.split("/").slice(-1)[0];
  const filepath = path.resolve(DATA_DIR, filename);
  const file = fs.createWriteStream(filepath);
  https.get(url, res => res.pipe(file));
};
download("https://geoblaze.s3.amazonaws.com/wildfires.tiff");
download("https://s3-us-west-2.amazonaws.com/planet-disaster-data/hurricane-harvey/SkySat_Freeport_s03_20170831T162740Z3.tif");

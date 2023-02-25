#!/bin/sh -e

# download from https://github.com/GeoTIFF/test-data/
wget https://github.com/GeoTIFF/test-data/archive/refs/heads/main.zip -O geotiff-test-data.zip
unzip -j -o geotiff-test-data.zip "test-data-*/files/*" -d .
rm geotiff-test-data.zip

wget https://geowarp.s3.amazonaws.com/SkySat_Freeport_s03_20170831T162740Z3.tif

wget https://raw.githubusercontent.com/GeoTIFF/georaster-layer-for-leaflet-example/master/example_4326.tif

wget https://georaster-layer-for-leaflet.s3.amazonaws.com/check.tif

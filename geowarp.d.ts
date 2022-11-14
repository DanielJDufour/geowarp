type bbox = Readonly<[number, number, number, number]> | Readonly<[string, string, string, string]> | number[] | string[];
type srs = number | string;
type reproject = (pt: [number, number]) => [number, number];
type data = number[] | number[][] | number[][][] | any;

export default function geowarp(options: {
  debug_level?: number,
  forward?: reproject,
  inverse?: reproject,
  in_data: data,
  in_bbox: bbox,
  in_layout?: string,
  in_no_data?: number | null | undefined,
  in_srs?: srs | undefined,
  in_width: number,
  in_height: number,
  out_array_types?: ReadonlyArray<"Array" | "Int8Array" | "Uint8Array" | "Uint8ClampedArray" | "Int16Array" | "Uint16Array" | "Float32Array" | "Float64Array" | "BigInt64Array" | "BigUint64Array"> | undefined,
  out_bands?: number[] | Readonly<number[]> | undefined,
  out_bbox?: bbox | undefined,
  out_data?: data,
  out_layout?: string | undefined,
  out_no_data?: number | null | undefined,
  out_srs?: srs | undefined,
  out_pixel_depth?: number | undefined,
  out_height: number,
  out_width: number,
  method?: string | ((arg: { values: number[] }) => number) | undefined,
  round?: boolean | undefined,
  row_start?: number | undefined,
  row_end?: number | undefined,
  theoretical_min?: number | undefined,
  theoretical_max?: number | undefined,
  expr?: ((arg: { pixel: number[] }) => number[]) | undefined,
  read_bands?: number[] | undefined,
  cutline?: any,
  cutline_srs?: number | string | undefined,
  cutline_forward?: reproject | undefined
}): {
  data: number[] | number[][] | number[][][],
  out_bands: number[],
  out_layout: string,
  out_pixel_height: number,
  out_pixel_width: number,
  read_bands: number[]
};

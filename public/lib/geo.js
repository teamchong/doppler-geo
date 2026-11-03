const R = 6371008.8, RAD = Math.PI / 180;
export const FT = 0.3048, KT = 0.514444;

// Local tangent plane in meters around (lat0, lon0).
export function frameAt(lat0, lon0) {
  const ky = R * RAD, kx = ky * Math.cos(lat0 * RAD);
  return {
    lat0, lon0,
    x: (lon) => (lon - lon0) * kx,
    y: (lat) => (lat - lat0) * ky,
    lat: (y) => lat0 + y / ky,
    lon: (x) => lon0 + x / kx,
  };
}

export function distM(lat1, lon1, lat2, lon2) {
  const a = Math.sin(((lat2 - lat1) * RAD) / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(((lon2 - lon1) * RAD) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const tx = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const ty = (lat, z) => Math.floor(((1 - Math.log(Math.tan(lat * RAD) + 1 / Math.cos(lat * RAD)) / Math.PI) / 2) * 2 ** z);

// AWS Terrain Tiles (terrarium encoding), meters above sea level. Sea floor is clamped to 0.
export class Dem {
  constructor(z = 10, tiles = new Map()) {
    this.z = z;
    this.tiles = tiles;
  }

  static from(o) {
    return new Dem(o.z, new Map(o.tiles));
  }

  export() {
    return { z: this.z, tiles: [...this.tiles] };
  }

  async load(s, w, n, e, maxTiles = 36) {
    let z = 11;
    const count = (z) => (tx(e, z) - tx(w, z) + 1) * (ty(s, z) - ty(n, z) + 1);
    while (z > 6 && count(z) > maxTiles) z--;
    this.z = z;
    const jobs = [];
    for (let x = tx(w, z); x <= tx(e, z); x++)
      for (let y = ty(n, z); y <= ty(s, z); y++) {
        jobs.push(
          (async () => {
            const r = await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`);
            if (!r.ok) return;
            const bmp = await createImageBitmap(await r.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
            const ctx = new OffscreenCanvas(256, 256).getContext('2d');
            ctx.drawImage(bmp, 0, 0);
            const d = ctx.getImageData(0, 0, 256, 256).data, el = new Float32Array(65536);
            for (let i = 0; i < 65536; i++) el[i] = Math.max(0, d[4 * i] * 256 + d[4 * i + 1] + d[4 * i + 2] / 256 - 32768);
            this.tiles.set(`${x}/${y}`, el);
          })().catch(() => {}),
        );
      }
    await Promise.all(jobs);
  }

  at(lat, lon) {
    const N = 256 * 2 ** this.z;
    const px = ((lon + 180) / 360) * N;
    const py = ((1 - Math.log(Math.tan(lat * RAD) + 1 / Math.cos(lat * RAD)) / Math.PI) / 2) * N;
    const x0 = Math.floor(px / 256), y0 = Math.floor(py / 256), el = this.tiles.get(`${x0}/${y0}`);
    if (!el) return 0;
    const fx = Math.min(254.999, Math.max(0, px - x0 * 256 - 0.5)), fy = Math.min(254.999, Math.max(0, py - y0 * 256 - 0.5));
    const ix = fx | 0, iy = fy | 0, ax = fx - ix, ay = fy - iy, i = iy * 256 + ix;
    return (el[i] * (1 - ax) + el[i + 1] * ax) * (1 - ay) + (el[i + 256] * (1 - ax) + el[i + 257] * ax) * ay;
  }
}

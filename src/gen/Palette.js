/**
 * Palette — colour-space helpers for hand-authored vertex colours.
 *
 * three.js treats a `color` vertex attribute as **linear** working-space data,
 * while `THREE.Color.set(0xRRGGBB)` converts from sRGB on the way in. Authoring
 * some colours as hex and others as raw triples therefore produces a silent
 * 2-4x brightness mismatch between meshes. Everything hand-authored in this
 * project is written in sRGB and pushed through `srgb()` exactly once.
 */

/** Single sRGB channel (0..1) to linear. */
export function channelToLinear(c) {
  return c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4);
}

/** sRGB triple (0..1) to a linear triple. */
export function srgb(r, g, b, out = [0, 0, 0]) {
  out[0] = channelToLinear(r);
  out[1] = channelToLinear(g);
  out[2] = channelToLinear(b);
  return out;
}

/** 0xRRGGBB to a linear triple. */
export function srgbHex(hex, out = [0, 0, 0]) {
  return srgb(((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255, out);
}

/** Convert an array of sRGB triples to linear, in place. */
export function srgbAll(list) {
  for (const c of list) srgb(c[0], c[1], c[2], c);
  return list;
}

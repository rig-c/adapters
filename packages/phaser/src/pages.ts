import Phaser from 'phaser';

type Renderer = Phaser.Renderer.WebGL.WebGLRenderer;
export interface RetainedPage {
  texture: Phaser.Textures.Texture;
  image: HTMLImageElement;
  pma: boolean;
  holders: Set<object>;
}
interface Registry { images: WeakMap<HTMLImageElement, Map<boolean, RetainedPage>>; live: Set<RetainedPage> }
const registries = new WeakMap<Renderer, Registry>();
let nextPage = 0;
function registry(renderer: Renderer): Registry {
  let value = registries.get(renderer);
  if (!value) { value = { images: new WeakMap(), live: new Set() }; registries.set(renderer, value); }
  return value;
}

export function retainPage(renderer: Renderer, manager: Phaser.Textures.TextureManager, image: HTMLImageElement, pma: boolean, owner: object): RetainedPage {
  const values = registry(renderer);
  let variants = values.images.get(image);
  if (!variants) { variants = new Map(); values.images.set(image, variants); }
  let entry = variants.get(pma);
  if (!entry) {
    const gl = renderer.gl;
    const wrapper = renderer.createTexture2D(0, gl.LINEAR, gl.LINEAR, gl.CLAMP_TO_EDGE, gl.CLAMP_TO_EDGE, gl.RGBA, image, image.naturalWidth, image.naturalHeight, !pma, false, true);
    const texture = manager.addGLTexture(`rigc-phaser-page-${++nextPage}`, wrapper);
    if (!texture) { renderer.deleteTexture(wrapper); throw new Error('PhaserRenderer: native page registration failed (expected unique texture key)'); }
    texture.setFilter(Phaser.Textures.FilterMode.LINEAR);
    entry = { texture, image, pma, holders: new Set() }; variants.set(pma, entry); values.live.add(entry);
  }
  entry.holders.add(owner); return entry;
}

export function releasePage(renderer: Renderer, manager: Phaser.Textures.TextureManager, entry: RetainedPage, owner: object): void {
  if (!entry.holders.delete(owner) || entry.holders.size !== 0) return;
  manager.remove(entry.texture);
  const values = registry(renderer); values.images.get(entry.image)?.delete(entry.pma); values.live.delete(entry);
}

/** Counts only adapter-owned pages in this native renderer/context. */
export function getPhaserLivePageTextureCount(renderer: Renderer): number { return registries.get(renderer)?.live.size ?? 0; }
export function getPhaserPageRefCount(renderer: Renderer, image: HTMLImageElement, pma = false): number { return registries.get(renderer)?.images.get(image)?.get(pma)?.holders.size ?? 0; }
export function getPhaserPageTexture(renderer: Renderer, image: HTMLImageElement, pma = false): Phaser.Textures.Texture | undefined { return registries.get(renderer)?.images.get(image)?.get(pma)?.texture; }

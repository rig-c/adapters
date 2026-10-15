import Phaser from 'phaser';
import { RigPlayer, type ModelAssets, type PlayOptions, type RigPlayerOptions, type PosedFrame, type BoneWorld, type PoseBounds, type SlotFilter } from '@rig-c/play';
import { PhaserRenderer } from './phaser.ts';

export interface PhaserRigOptions extends Pick<RigPlayerOptions, 'skin' | 'slots' | 'seekStep'> {
  timescale?: number;
  timeScale?: number;
  /** Scene UPDATE drives seconds into the player; false leaves stepping to the caller. */
  autoUpdate?: boolean;
}

function numberAtLeastZero(value: number, detail: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`PhaserRig: invalid ${detail}=${String(value)} (expected finite number >= 0)`);
}

/** Native Container with an independent player; supplied ModelAssets stay caller-owned. */
export class PhaserRig extends Phaser.GameObjects.Container {
  readonly player: RigPlayer;
  readonly renderer: PhaserRenderer;
  private readonly updates: Phaser.Events.EventEmitter;
  private rigDestroyed = false;
  private readonly onSceneShutdown = (): void => { this.destroy(true); };
  private readonly tick = (_time: number, deltaMS: number): void => { this.advance(deltaMS / 1000); };

  constructor(scene: Phaser.Scene, readonly assets: ModelAssets, options: PhaserRigOptions = {}) {
    if (!scene?.sys?.events) throw new Error('PhaserRig: invalid scene (expected active Phaser.Scene)');
    super(scene, 0, 0);
    if (!assets?.document || !(assets.pageImages instanceof Map)) throw new Error('PhaserRig: invalid assets (expected ModelAssets document and pageImages Map)');
    const scale = options.timescale ?? options.timeScale ?? 1;
    numberAtLeastZero(scale, 'timescale');
    this.updates = scene.sys.events;
    this.player = new RigPlayer(document.createElement('div'), assets, { mode: 'canvas', skin: options.skin, slots: options.slots, seekStep: options.seekStep });
    let renderer: PhaserRenderer | undefined;
    try {
      this.player.timeScale = scale;
      renderer = new PhaserRenderer(this, assets);
      this.renderer = renderer;
      this.renderer.render(this.player.posedFrame());
    } catch (error) {
      renderer?.dispose();
      this.player.dispose();
      throw error;
    }
    if (options.autoUpdate !== false) this.updates.on(Phaser.Scenes.Events.UPDATE, this.tick);
    this.updates.once(Phaser.Scenes.Events.SHUTDOWN, this.onSceneShutdown);
    this.updates.once(Phaser.Scenes.Events.DESTROY, this.onSceneShutdown);
  }

  private ensureActive(method: string): void {
    if (this.rigDestroyed) throw new Error(`PhaserRig: cannot call ${method} on a destroyed PhaserRig`);
  }

  play(name: string, options: PlayOptions = {}): void {
    this.ensureActive('play');
    if (typeof name !== 'string' || !name) throw new Error(`PhaserRig: invalid animation name ${String(name)} (expected nonempty string)`);
    this.player.play(name, options);
    this.draw();
  }

  advance(dt: number): void {
    this.ensureActive('advance');
    numberAtLeastZero(dt, 'dt');
    this.player.advance(dt);
    this.draw();
  }

  seek(time: number): void {
    this.ensureActive('seek');
    numberAtLeastZero(time, 'time');
    this.player.seek(time);
    this.draw();
  }

  draw(): PosedFrame {
    this.ensureActive('draw');
    const frame = this.player.posedFrame();
    this.renderer.render(frame);
    return frame;
  }

  drawnFrame(): PosedFrame {
    this.ensureActive('drawnFrame');
    return this.renderer.drawnFrame!;
  }

  posedFrame(slots?: SlotFilter | null): PosedFrame {
    this.ensureActive('posedFrame');
    if (slots === undefined) return this.player.posedFrame();
    return this.player.posedFrame(slots);
  }

  bone(name: string): BoneWorld {
    this.ensureActive('bone');
    if (typeof name !== 'string' || !name) throw new Error(`PhaserRig: invalid bone name ${String(name)} (expected nonempty string)`);
    return this.player.bone(name);
  }

  bounds(): PoseBounds | null {
    this.ensureActive('bounds');
    return this.player.bounds();
  }

  get time(): number { this.ensureActive('time'); return this.player.time; }
  get current(): string | null { this.ensureActive('current'); return this.player.current; }
  get timescale(): number { this.ensureActive('timescale'); return this.player.timeScale; }
  set timescale(value: number) { this.ensureActive('timescale'); numberAtLeastZero(value, 'timescale'); this.player.timeScale = value; }
  get timeScale(): number { return this.timescale; }
  set timeScale(value: number) { this.timescale = value; }
  get skin(): string | undefined { this.ensureActive('skin'); return this.player.skin; }
  set skin(value: string | undefined) { this.ensureActive('skin'); this.player.skin = value; this.draw(); }
  get slots(): SlotFilter | null { this.ensureActive('slots'); return this.player.slots; }
  set slots(value: SlotFilter | null) { this.ensureActive('slots'); this.player.slots = value; this.draw(); }

  override destroy(fromScene?: boolean): void {
    if (this.rigDestroyed || this.ignoreDestroy) return;
    this.rigDestroyed = true;
    this.updates.off(Phaser.Scenes.Events.UPDATE, this.tick);
    this.updates.off(Phaser.Scenes.Events.SHUTDOWN, this.onSceneShutdown);
    this.updates.off(Phaser.Scenes.Events.DESTROY, this.onSceneShutdown);
    this.renderer.dispose();
    this.player.dispose();
    super.destroy(fromScene);
  }
}

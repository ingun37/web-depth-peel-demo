import {
  Color,
  ColorRepresentation,
  DoubleSide,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
  ShaderMaterial,
  SphereBufferGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import {
  debounceTime,
  distinctUntilChanged,
  filter,
  map,
  merge,
  Observable,
  Subject,
  Subscription,
  tap,
} from "rxjs";

export enum IndicatorMode {
  ON,
  OFF,
}

export enum SubscriberEvent {
  Unsubscribed,
  Moved,
}

export class Indicators {
  instances: InstancedMesh;
  subscriptions: IndicatorSubscription[] = [];
  indicatorStatusRx = new Subject<IndicatorMode>();
  uniqueColor: Color;
  subscribersEvent = new Subject<SubscriberEvent>();
  pruneRx = new Subject();
  moveRx = new Subject();

  dispose() {
    this.instances.dispose();
    (this.instances.material as ShaderMaterial).dispose();
    while (0 < this.subscriptions.length)
      this.subscriptions.pop()?.unsubscribe();
    this.indicatorStatusRx.complete();
    this.subscribersEvent.complete();
    this.pruneRx.complete();
    this.moveRx.complete();
    this.render();
  }
  constructor(
    private renderer: WebGLRenderer,
    scene: Scene,
    private camera: PerspectiveCamera,
    initialScreenHeight: number,
    circleSegment: number,
    radius: number,
    color: ColorRepresentation,
    private cameraMoveRx: Observable<any>,
    private render: () => void
  ) {
    this.uniqueColor = new Color(color);
    // const g = circleGeometry(circleSegment, radius);
    const g = new SphereBufferGeometry(radius);
    const m2 = new MeshBasicMaterial({
      side: DoubleSide,
      color,
      depthWrite: false,
    });
    this.instances = new InstancedMesh(g, m2, 100);
    this.instances.count = 0;
    scene.add(this.instances);
    merge(
      cameraMoveRx.pipe(map(() => IndicatorMode.ON)),
      cameraMoveRx.pipe(
        debounceTime(300),
        map(() => IndicatorMode.OFF)
      )
    ).subscribe(this.indicatorStatusRx);

    this.subscribersEvent
      .pipe(
        filter((e) => e === SubscriberEvent.Unsubscribed),
        tap(() => {
          this.subscriptions = this.subscriptions.filter((x) => x.isAlive());
          this.instances.count = this.subscriptions.length;
          render();
        })
      )
      .subscribe(this.pruneRx);
    this.subscribersEvent
      .pipe(filter((e) => e === SubscriberEvent.Moved))
      .subscribe(this.moveRx);
    this.indicatorStatusRx.pipe(distinctUntilChanged()).subscribe((status) => {
      if (status === IndicatorMode.ON) {
        this.instances.visible = true;
      } else if (status === IndicatorMode.OFF) {
        requestAnimationFrame(() => {
          this.instances.visible = false;
          this.render();
        });
      }
    });
  }

  subscribe(
    pos: { x: number; y: number; z: number },
    size: number,
    callback: (
      param:
        | {
            indicatorMode: "off";
            lastlyVisible: boolean;
          }
        | {
            indicatorMode: "on";
          }
    ) => void
  ) {
    const screenSize = new Vector2();
    const pV3 = new Vector3();
    const t = new Matrix4().makeTranslation(pos.x, pos.y, pos.z);
    const s = new Matrix4();
    const transform = new Matrix4().identity().multiply(t).multiply(s);
    const initialIdx = this.subscriptions.length;
    this.instances.count = initialIdx + 1;
    this.instances.setMatrixAt(initialIdx, transform);
    this.instances.instanceMatrix.needsUpdate = true;
    const ctx = this.renderer.getContext();
    const pixelBuffer = new Uint8Array(4);

    const subscription = this.indicatorStatusRx
      .pipe(
        distinctUntilChanged()
        // auditTime(0, animationFrameScheduler)
      )
      .subscribe((indicatorEnabled) => {
        switch (indicatorEnabled) {
          case IndicatorMode.ON:
            callback({ indicatorMode: "on" });
            break;
          case IndicatorMode.OFF:
            const ndc = pV3
              .set(t.elements[12], t.elements[13], t.elements[14])
              .project(this.camera);
            const pixelRatio = this.renderer.getPixelRatio() ?? 1;
            this.renderer.getSize(screenSize);
            const dx = Math.floor(
              ((ndc.x + 1) * screenSize.width * pixelRatio) / 2
            );
            const dy = Math.floor(
              ((ndc.y + 1) * screenSize.height * pixelRatio) / 2
            );
            let isVisible = false;
            const color = this.uniqueColor;
            if (
              0 <= dx &&
              0 <= dy &&
              dx < screenSize.width * pixelRatio &&
              dy < screenSize.height * pixelRatio
            ) {
              ctx.readPixels(
                dx,
                dy,
                1,
                1,
                ctx.RGBA,
                ctx.UNSIGNED_BYTE,
                pixelBuffer
              );

              isVisible =
                pixelBuffer[0] === scale255(color.r) &&
                pixelBuffer[1] === scale255(color.g) &&
                pixelBuffer[2] === scale255(color.b);
            }

            callback({ indicatorMode: "off", lastlyVisible: isVisible });
            break;
        }
      });
    const isub = new IndicatorSubscription(subscription, t);

    const updateTransform = () => {
      const idx = this.subscriptions.indexOf(isub);
      if (idx === -1) throw new Error("Failed to find subscription");
      const viewP = pV3
        .set(t.elements[12], t.elements[13], t.elements[14])
        .applyMatrix4(this.camera.matrixWorldInverse);
      this.renderer.getSize(screenSize);
      const standardZ = screenSize.height / (2 * Math.tan(this.camera.fov / 2));
      const fixedSizeScale = (size * -viewP.z) / standardZ;

      s.makeScale(fixedSizeScale, fixedSizeScale, fixedSizeScale);
      transform.identity().multiply(t).multiply(s);
      this.instances.setMatrixAt(idx, transform);
      this.instances.instanceMatrix.needsUpdate = true;
      this.render();
    };

    subscription.add(
      merge(this.cameraMoveRx, this.pruneRx, this.moveRx).subscribe(
        updateTransform
      )
    );
    this.subscriptions.push(isub);

    updateTransform();

    // Not doing
    // events.subscribe(this.subscribersEvent)
    // Because we don't want subscriber to complete along with observable
    // Ingun, July 14 2022.
    isub.events.subscribe((e) => this.subscribersEvent.next(e));
    return isub;
  }
}

export class IndicatorSubscription {
  events = new Subject<SubscriberEvent>();

  constructor(
    private subscription: Subscription,
    private translationMatrix: Matrix4
  ) {}

  unsubscribe() {
    this.subscription.unsubscribe();
    this.events.next(SubscriberEvent.Unsubscribed);
    this.events.complete();
  }

  move(x: number, y: number, z: number) {
    this.translationMatrix.makeTranslation(x, y, z);
    this.events.next(SubscriberEvent.Moved);
  }
  isAlive(): boolean {
    return !this.subscription.closed;
  }
}

function scale255(f0to1: number) {
  return Math.floor(255 * f0to1);
}

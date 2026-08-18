# ARCHITECTURE.md — Mobile Battle Royale (Fortnite-like TPS / Building)

> モバイルブラウザ (Chrome / タッチ操作) で 30fps 以上を維持する、オフライン単独プレイの
> バトルロイヤル TPS + 建築ゲーム。Three.js 使用。**アートアセットは一切使わず**、
> テクスチャ・モデル・サウンドはすべて実行時に手続き的生成する。

---

## 0. 設計原則 (Design Principles)

| # | 原則 | 具体化 |
|---|------|--------|
| P1 | **ゼロアセット** | 画像/GLTF/音声ファイルを一切読み込まない。Canvas2D → `CanvasTexture`、`BufferGeometry` 直接構築、`WebAudio` 合成のみ。 |
| P2 | **モバイルファースト予算** | Draw call ≤ 150、三角形 ≤ 350k、テクスチャ VRAM ≤ 48MB、CPU フレーム ≤ 8ms を恒常予算とする。 |
| P3 | **決定論的シミュレーション** | 全ランダムはシード付き RNG 経由。`?seed=` で完全再現。スクリーンショット回帰テストの前提。 |
| P4 | **固定タイムステップ** | シミュレーションは 60Hz 固定、描画は可変。低スペック機でも挙動が変わらない。 |
| P5 | **サブシステム疎結合** | 各サブシステムは `Services` レジストリ経由でのみ相互参照。直接 import による循環依存を禁止。 |
| P6 | **テスト可能性を設計に埋め込む** | `window.__GAME` に検証用 API を公開。ヘッドレスから状態注入・計測・タッチ合成が可能。 |
| P7 | **プール & インスタンシング** | 毎フレームのアロケーションを 0 に近づける。弾痕・パーティクル・数値表示・建築片はすべてプール。 |

---

## 1. レイヤ構成 (Layering)

```
┌─────────────────────────────────────────────────────────────────┐
│ L4  Game        MatchDirector / Storm / Loot / Inventory / Score │
├─────────────────────────────────────────────────────────────────┤
│ L3  Gameplay    Player / Camera / Build / Weapons / Bots / FX    │
├─────────────────────────────────────────────────────────────────┤
│ L2  Sim & World Physics / Terrain / Structures / Spatial index   │
├─────────────────────────────────────────────────────────────────┤
│ L1  Generation  RNG / Noise / TextureGen / MeshGen / AudioGen    │
├─────────────────────────────────────────────────────────────────┤
│ L0  Core        Engine / Loop / Renderer / Services / Bus / Prof │
└─────────────────────────────────────────────────────────────────┘
```

依存は **上から下への一方向のみ**。下位は上位を知らない。
横断的通知は `EventBus` (L0) の pub/sub で行う。

---

## 2. ディレクトリ構成

```
/
├── ARCHITECTURE.md
├── index.html                 # importmap + ブートストラップ
├── package.json
├── src/
│   ├── main.js                # エントリ: Engine 生成 → サブシステム登録 → start
│   ├── core/
│   │   ├── Engine.js          # ライフサイクル所有、固定ステップループ
│   │   ├── Services.js        # サービスロケータ (型なし DI)
│   │   ├── EventBus.js        # pub/sub, フレーム末尾フラッシュ
│   │   ├── Profiler.js        # CPU/GPU 区間計測, パーセンタイル集計
│   │   ├── Renderer.js        # WebGLRenderer ラッパ, 適応解像度
│   │   ├── Settings.js        # 品質プリセット, 永続化 (localStorage)
│   │   └── Pool.js            # 汎用オブジェクトプール
│   ├── gen/
│   │   ├── Rng.js             # PCG32 / xorshift128, 派生ストリーム
│   │   ├── Noise.js           # value / simplex / fBm / ridged / worley
│   │   ├── TextureGen.js      # Canvas2D → CanvasTexture (+ normal 派生)
│   │   ├── MeshGen.js         # 手続き的 BufferGeometry ビルダ
│   │   └── AudioGen.js        # WebAudio ノイズ/FM/エンベロープ合成
│   ├── world/
│   │   ├── Terrain.js         # ハイトマップ, チャンク, LOD, 高さ問い合わせ
│   │   ├── Biome.js           # 高度/湿度 → 色・植生密度
│   │   ├── Sky.js             # 空ドーム, 太陽, フォグ, 大気散乱近似
│   │   ├── Vegetation.js      # 樹木/岩/草の InstancedMesh 散布
│   │   ├── Structures.js      # POI 生成 (建物/道路/柵/コンテナ)
│   │   └── Colliders.js       # 静的 AABB のグリッド空間分割
│   ├── sim/
│   │   ├── Physics.js         # カプセル移動解決, レイキャスト, 重力
│   │   └── SpatialHash.js     # 動的エンティティの近傍探索
│   ├── player/
│   │   ├── PlayerController.js
│   │   ├── CameraRig.js       # スプリングアーム, 遮蔽回避, ADS
│   │   └── CharacterMesh.js   # 手続き的キャラ + 手続きアニメーション
│   ├── build/
│   │   ├── BuildSystem.js     # 配置/検証/破壊/編集
│   │   └── BuildGrid.js       # セル座標 ⇄ ワールド座標, 占有管理
│   ├── combat/
│   │   ├── Weapons.js         # 武器定義テーブル + レアリティ
│   │   ├── WeaponMesh.js      # 手続き的武器モデル
│   │   └── CombatSystem.js    # 射撃/命中判定/ダメージ適用
│   ├── ai/
│   │   └── BotManager.js      # FSM ボット群
│   ├── fx/
│   │   ├── ParticleSystem.js  # 単一 InstancedMesh, GPU 進行
│   │   ├── Tracers.js         # ライン弾道
│   │   └── Decals.js          # 弾痕プール
│   ├── audio/
│   │   └── AudioSystem.js     # バス構成, 距離減衰, 同時発音制限
│   ├── ui/
│   │   ├── Hud.js             # DOM HUD
│   │   ├── Minimap.js         # Canvas2D ミニマップ
│   │   ├── Screens.js         # スタート/結果/設定
│   │   └── DamageNumbers.js   # ワールド空間 → 画面投影
│   ├── input/
│   │   ├── TouchInput.js      # マルチタッチ, 仮想スティック
│   │   └── DesktopInput.js    # キーボード/マウス フォールバック
│   └── game/
│       ├── MatchDirector.js   # 試合状態機械
│       ├── Storm.js           # 収縮サークル + ダメージ
│       ├── Loot.js            # チェスト/床アイテム/弾薬
│       └── Inventory.js       # スロット/素材/消費アイテム
└── tests/
    ├── harness.cjs            # サーバ起動 + ブラウザ起動 + 共通ユーティリティ
    ├── screenshots.cjs        # 決定論的スクリーンショット取得
    ├── regress.cjs            # ベースライン差分比較
    ├── perf.cjs               # フレームタイム p50/p95/p99
    ├── touch.cjs              # タッチ操作の機能テスト
    ├── run-all.cjs            # 全検証の実行 + 判定
    └── baseline/              # 承認済みスクリーンショット
```

---

## 3. コア (L0)

### 3.1 `Engine`
ゲーム全体のライフサイクル所有者。

```js
class Engine {
  constructor(canvas, opts)
  register(name, system)     // system: { init?, fixedUpdate?, update?, render?, dispose?, order? }
  start() / stop()
  get services(): Services
}
```

**ループ規約 (固定タイムステップ + アキュムレータ)**

```
frame(now):
  dt = min(now - last, MAX_FRAME_MS)      // スパイラル防止 (上限 100ms)
  acc += dt
  while acc >= FIXED_DT:                  // FIXED_DT = 1/60 s
      for s in systems: s.fixedUpdate(FIXED_DT)
      acc -= FIXED_DT
  alpha = acc / FIXED_DT                  // 補間係数
  for s in systems: s.update(dt, alpha)   // 描画向け補間・UI・FX
  renderer.render(scene, camera)
  bus.flush()
  profiler.endFrame()
```

- `fixedUpdate`: 決定論が必要なもの (移動、AI、弾道、ストーム、建築判定)
- `update`: 決定論不要なもの (カメラ平滑化、パーティクル、HUD、音)
- 実行順は `order` 数値の昇順で安定ソート。

### 3.2 `Services`
サービスロケータ。`services.get('terrain')` で解決。
循環 import を避けつつ、初期化順序を明示的に制御するため。
未登録アクセスは即座に例外 (サイレント undefined を禁止)。

### 3.3 `EventBus`
```js
bus.on(type, fn) -> unsubscribe
bus.emit(type, payload)      // 即時ディスパッチ
bus.queue(type, payload)     // フレーム末尾でまとめてディスパッチ
```
主要イベント:
`player:damaged` `entity:eliminated` `build:placed` `build:destroyed`
`weapon:fired` `weapon:hit` `loot:picked` `storm:phase` `match:state`

### 3.4 `Profiler`
- `begin(label)` / `end(label)` の階層区間計測。
- リングバッファ (1024 フレーム) に `frameMs` `cpuMs` `simMs` `renderMs` を保存。
- `percentiles()` → `{p50, p95, p99, mean, min, max}`。
- `renderer.info` から `calls` `triangles` `programs` を毎フレーム取り込み。
- ヘッドレス検証はこの API を直接読む。

### 3.5 `Renderer`
- `WebGLRenderer` (`antialias` は品質プリセット依存、モバイル既定 off)。
- **適応解像度**: 直近 30 フレームの p95 が閾値を超えたら `pixelRatio` を
  `1.0 → 0.85 → 0.7 → 0.6` と段階的に下げ、余裕があれば戻す (ヒステリシス付き)。
- 出力は `ACESFilmicToneMapping` + `SRGBColorSpace`。
- シャドウは `PCFSoftShadowMap`、単一ディレクショナルライトのみ、
  カメラ追従のタイトなシャドウカメラ (範囲 60m)。

---

## 4. 手続き的生成 (L1)

### 4.1 `Rng`
PCG32 相当の 32bit ストリーム。
```js
const rng = new Rng(seed);
rng.next()        // [0,1)
rng.int(n) / rng.range(a,b) / rng.pick(arr) / rng.chance(p)
rng.stream(tag)   // 独立した子ストリーム (サブシステム間の干渉防止)
```
**規約**: グローバル `Math.random()` の使用をコードベース全体で禁止する
(テストで grep 検査)。子ストリーム分離により、あるサブシステムの
乱数消費回数が変わっても他の見た目が変化しない。

### 4.2 `Noise`
`value2/3`, `simplex2/3`, `fbm(x,y,octaves,lacunarity,gain)`,
`ridged`, `worley2`。地形・テクスチャ・植生散布の共通基盤。

### 4.3 `TextureGen`
Canvas2D で生成 → `CanvasTexture`。
- 生成器: `grass` `dirt` `rock` `wood` `plank` `brick` `concrete` `metal`
  `sand` `bark` `leaf(alpha)` `cloud` `noise` `gradientSky` `uiIcon`
- すべて **タイル可能** (トロイダル座標でノイズ評価)。
- `normalFromHeight(canvas, strength)` で法線マップを Sobel 導出。
- サイズは品質プリセット連動 (低: 128, 中: 256, 高: 512)。
- **アトラス化**: 建築部材とプロップは 1 枚の 1024² アトラスに統合し
  draw call とマテリアル切替を削減。
- 生成結果は `key` でキャッシュ。同一テクスチャの再生成を防ぐ。

### 4.4 `MeshGen`
`BufferGeometry` を直接構築するユーティリティ。
`box` `roundedBox` `cylinder` `capsule` `cone` `plane(subdiv)`
`extrudeProfile` `lathe` `treeTrunk(branchRecursion)` `foliageBillboards`
`rockLump(noiseDisplace)` `stairs` `windowFrame`。
すべて **頂点カラー対応** (マテリアル数削減のため色は頂点に焼く)。

### 4.5 `AudioGen`
`AudioBuffer` をオフラインで合成しキャッシュ。
- 銃声: ホワイトノイズバースト × 指数エンベロープ + ローパススイープ + 低域サイン (ボディ)
- リロード: 短いクリック (フィルタ済みインパルス) の連なり
- 足音: バンドパスノイズ + サーフェス依存の中心周波数
- 建築: 木/石/金属の共振 (減衰サイン群)
- ストーム: ピンクノイズ + LFO ゆらぎ (ループ)
- UI/被弾/撃破: FM シンセの短音

---

## 5. ワールド (L2)

### 5.1 `Terrain`
- マップ: **1024m × 1024m**、ハイトマップ解像度 2m/セル (512×512)。
- 生成: `fbm` 大陸マスク + `ridged` 山岳 + 川用の距離場減算 + 平地平坦化 (POI 用)。
- チャンク: 64m × 64m を 1 チャンク → 16×16 = 256 チャンク。
- **LOD**: カメラ距離で 3 段 (32×32 / 16×16 / 8×8 頂点)。
  隣接 LOD 差はスカート (垂直エッジ) で継ぎ目を隠す。
- 可視チャンクのみシーンに存在 (視錐台 + 距離カリング、可視 ≤ 40 チャンク)。
- **公開 API** (他サブシステムはこれのみ使用):
  ```js
  terrain.heightAt(x, z) -> y            // バイリニア補間
  terrain.normalAt(x, z) -> Vector3
  terrain.biomeAt(x, z) -> BiomeId
  terrain.raycastDown(x, z, fromY) -> {y, normal}
  terrain.isInsideMap(x, z) -> bool
  ```

### 5.2 `Colliders`
静的コライダ (建物・岩・木の幹・建築部材) を **均一グリッド (8m セル)** に登録。
```js
colliders.add(aabb, meta) -> handle
colliders.remove(handle)
colliders.query(aabb, out[]) -> count
colliders.raycast(origin, dir, maxT) -> {t, normal, meta} | null
```
建築部材の追加/破壊が頻繁なので、追加/削除は O(占有セル数)。

### 5.3 `Physics`
- キャラクタは **カプセル** (半径 0.35m、高さ 1.8m)。
- 移動解決: 水平をスイープ → 接触面へ射影 (最大 3 回反復) → 垂直を解決。
- 段差昇り: 高さ ≤ 0.55m は自動で乗り上げ。
- 斜面: 45° 超は滑落。
- 弾丸は `raycast` のみ (剛体シミュレーションは行わない)。

### 5.4 `Vegetation` / `Structures`
- 樹木・岩・草はタイプ別 `InstancedMesh` (1 タイプ 1 draw call)。
- 草はカメラ周囲 40m のみ、チャンク移動時に差分更新。
- POI 建物は **部材を BufferGeometryUtils でマージ** し、POI 単位で 1〜3 draw call。
- POI 種別: `town` (集合住宅), `factory` (倉庫), `camp` (小屋群), `tower` (塔),
  `farm` (納屋+サイロ)。各 POI はシード分岐で内部レイアウトを変える。

---

## 6. ゲームプレイ (L3)

### 6.1 `PlayerController`
状態: `位置 / 速度 / ヨー / ピッチ / 接地 / 姿勢 / HP / シールド / 素材`。
入力は正規化された `InputState` のみを読む (入力デバイスを知らない)。
```js
InputState = {
  move: {x, y},        // [-1,1] 左スティック
  look: {dx, dy},      // このフレームの視点デルタ (rad)
  fire: bool, aim: bool, jump: bool, sprint: bool, crouch: bool,
  reload: bool, interact: bool,
  buildMode: bool, buildPiece: 0..3, buildRotate: bool, editMode: bool,
  slot: -1|0..4, useItem: bool
}
```
速度: 歩行 4.4 / 走行 7.2 / しゃがみ 2.2 / 空中制御 0.25 (m/s)。
ジャンプ初速 6.5 m/s、重力 -22 m/s²（ゲーム的な機敏さのため実重力より強め）。

### 6.2 `CameraRig`
- スプリングアーム: 目標オフセット (右肩 0.55m, 高さ 1.55m, 距離 3.4m)。
- 遮蔽: アームに沿ってレイキャストし、衝突点手前へカメラを引く (平滑復帰)。
- ADS: FOV 75° → 武器別 (48〜28°)、オフセットを中央寄りに補間。
- 反動は **カメラのピッチ/ヨーオフセット** として加算 → 時間で回復。
- ダメージ時の軽いシェイク、着地時の上下バウンス。

### 6.3 `BuildSystem`
- グリッド: **4m 立方**。セル座標 `(cx, cy, cz)` + `slot` で部材位置を一意化。
- 部材: `WALL` (面), `FLOOR` (床), `STAIR` (階段), `CONE` (屋根/ピラミッド)。
- 壁は 4 面 (N/E/S/W)、床は 1、階段/屋根は 4 方向回転。
- 配置判定: `grid.occupied(key)` が空 かつ 素材が足りる かつ プレイヤーと非交差。
- ゴースト表示: 有効=シアン半透明、無効=赤半透明。
- 素材: 木 (HP 140, 建築速度 速) / レンガ (HP 300) / 金属 (HP 500)。
  設置直後は HP が低く、時間経過で最大値まで上昇 (フォートナイト同様)。
- 破壊: HP 0 で `build:destroyed` → コライダ削除 + 破片パーティクル +
  上に乗っている部材の支持チェック (簡易: 浮遊部材は落下せず存続。
  ただし床/階段は支持なしでは配置不可)。
- 編集: 部材を注視して編集ジェスチャ → 3×3 グリッドのセルをタップで
  くり抜き → 確定で形状差し替え (壁: ドア/窓/半壁のプリセット)。

**公開 API**
```js
build.setPiece(pieceId) / build.setMaterial(matId)
build.previewAt(camera) -> {key, valid, matrix, piece}
build.place() -> bool
build.damage(key, amount, source) -> destroyed:bool
build.raycast(origin, dir, maxT) -> hit
```

### 6.4 `CombatSystem`
- 発射は `fixedUpdate` で発射レート制御。
- 命中判定: カメラ中心からの **ヒットスキャン**。判定順は
  `builds → bots → structures → terrain` を単一 `raycastAll` で統合し最小 t を採用。
- 弾ブレ (bloom): 基礎値 + 連射蓄積 + 移動/空中係数、ADS で縮小。
- 反動: 武器ごとのパターン配列 (縦横のオフセット列) + ランダム微小成分。
- ダメージ: 部位 (head ×2.0 / body ×1.0 / limb ×0.85)、距離減衰カーブ、
  建築物へは別係数 (ショットガンは対建築が弱い等)。
- ヒットマーカー、ダメージ数値、撃破時のキルフィード発火。

### 6.5 `BotManager`
FSM: `DROP → LOOT → ROAM → ENGAGE → COVER → ROTATE → DEAD`
- 更新は **時分割** (全ボットを 4 グループに分け、fixedUpdate ごとに 1 グループ)。
- 遠方ボット (>120m) は簡易更新 (位置補間のみ、描画は低 LOD)。
- 視認: 距離 + FOV + `colliders.raycast` の 3 段フィルタ。
- 交戦: 相手へストレイフ、`skill` に応じたエイム誤差 (角度ノイズ) と反応遅延。
- 被弾時は一定確率で壁を建てる (BuildSystem を通す = プレイヤーと同じ規則)。

### 6.6 `ParticleSystem` / `Tracers` / `Decals`
- パーティクルは **単一 `InstancedMesh`** (上限 1024)、CPU で寿命更新、
  インスタンス行列とカラーを毎フレーム部分更新 (`needsUpdate` は使用範囲のみ)。
- トレーサーは単一 `LineSegments` の頂点バッファを書き換え (上限 64)。
- デカールは上限 96 のリングバッファ、古いものから再利用。

### 6.7 `AudioSystem`
- バス: `master → {sfx, ambient, ui}`、各に `GainNode`。
- 3D 音は `PannerNode` ではなく **距離減衰 + ステレオパン** の軽量近似。
- 同種同時発音を 4 音に制限 (銃声の飽和防止)。
- 初回タッチで `AudioContext.resume()` (モバイル自動再生制限対応)。
- ヘッドレス環境では `AudioContext` が無くても全機能が動作すること (no-op fallback)。

---

## 7. ゲーム進行 (L4)

### 7.1 `MatchDirector`
```
IDLE → BUS → DEPLOY(skydive/glide) → PLAYING → RESULT
```
- BUS: バトルバスがマップを直線横断。タップで降下。
- DEPLOY: 自由落下 (最大 60 m/s) → 高度 40m 以下 or 手動でグライダー展開 (12 m/s)。
- PLAYING: ストーム進行、ボット交戦、生存者カウント。
- RESULT: 順位・撃破数・与ダメージを表示 → リスタート。

### 7.2 `Storm`
フェーズテーブル (待機秒 / 収縮秒 / 半径 / 秒間ダメージ) を 8 段階。
- 描画: 内側を切り抜いた円筒シェル (カスタムシェーダ、スクロールするノイズ)。
- 円外にいるエンティティに毎秒ダメージ。ボットは常に安全圏へ経路を取る。

### 7.3 `Loot` / `Inventory`
- チェスト (POI に配置、開封で 3〜5 個の抽選) と床ドロップ。
- レアリティ: `common/uncommon/rare/epic/legendary` — 色と性能倍率に反映。
- インベントリ: 武器 5 スロット + 素材 3 種 + 弾薬 4 種。
- 消費アイテム: シールドポーション (+50 シールド)、メドキット (HP 全快)。
- 素材採取: プロップ/樹木を近接ツルハシで叩いて木/石/金属を獲得。

---

## 8. 入力 (Input)

### 8.1 `TouchInput` (主系統)
Pointer Events (`pointerdown/move/up/cancel`) を `#touch-layer` で受ける。
`touch-action: none`、`user-select: none`、iOS のダブルタップズーム抑止。

**ゾーン分割 (画面比率で定義、セーフエリア考慮)**
```
┌────────────────────────────────────────────────┐
│ HUD 上部 (非入力)                                │
│                                                │
│  ┌──────────┐                    [ADS] [BUILD] │
│  │          │                                  │
│  │ 移動      │       視点ドラッグ領域       [JUMP]│
│  │ スティック │                          [FIRE]  │
│  └──────────┘                   [しゃがみ][ﾘﾛｰﾄﾞ]│
│  [クイックバー: 武器 1..5 / 建築 4 種]            │
└────────────────────────────────────────────────┘
```
- **移動**: 左下 45%×50% 領域。押した位置にスティック中心が出現する
  *フローティングジョイスティック*。半径 60px でクランプ、デッドゾーン 12%。
- **視点**: 上記ボタン/スティック以外の任意の場所のドラッグ。
  複数指の同時追跡 (`pointerId` でトラッキング)。
  感度は設定値 × (ADS 時は 0.55 倍)。1 フレーム分の指数平滑を掛ける。
- **射撃**: 右下ボタン。押下中連射。加えて「視点ドラッグ領域の
  ダブルタップ長押し」でも射撃可 (上級者向け)。
- **ジャンプ / しゃがみ / リロード / 使用**: 個別ボタン。
- **建築**: BUILD ボタンで建築モードトグル。建築中はクイックバーが
  壁/床/階段/屋根に切り替わり、**FIRE ボタンが「設置」** になる。
  ドラッグしながら設置し続けられる (ターボビルド)。
- **編集**: 建築モード中に EDIT ボタン → 注視部材の 3×3 グリッドを
  画面にオーバーレイ表示 → セルをタップ/ドラッグして選択 → 確定。
- ボタンは**押下判定を視覚境界より 25% 広く**取り、指のズレを許容。
- `navigator.vibrate` があれば発砲/被弾/設置で短い触覚フィードバック。

### 8.2 `DesktopInput` (フォールバック / 開発用)
WASD + マウスルック (Pointer Lock)、数字キー、F1〜F4 で建築部材。
両者とも同一の `InputState` を生成するため、上位は差異を知らない。

### 8.3 テスト用注入
`__GAME.input.override(partialInputState)` で任意の入力を注入でき、
`__GAME.input.clearOverride()` で解除。これによりタッチ合成に依存しない
ロジックテストと、実タッチイベント経路のテストの両方が可能。

---

## 9. UI / HUD

DOM ベース (Three.js のオーバーレイより安価かつ可読)。
- 上部: 生存者数 / 撃破数 / ストームタイマー
- 右上: ミニマップ (Canvas2D、地形の粗いカラーマップ + ストーム円 + 自機向き)
- 左下: HP バー (緑) + シールドバー (青)、素材 3 種
- 右下: 武器名 + 弾数、クイックバー
- 中央: クロスクロスヘア (状態で開き幅が変化)、ヒットマーカー
- ワールド空間ダメージ数値 (投影 + プール、上限 24)
- キルフィード (右上、最大 5 行、4 秒でフェード)

**更新規約**: HUD は毎フレーム DOM を書き換えない。値が変化したときだけ
`textContent` / `style.width` を更新する (差分キャッシュを保持)。

---

## 10. パフォーマンス戦略

| 項目 | 手法 | 予算 |
|------|------|------|
| Draw call | インスタンシング / ジオメトリマージ / アトラス | ≤ 150 |
| 三角形 | LOD 3 段 + 距離カリング | ≤ 350k |
| シャドウ | 単一ライト、1024² マップ、範囲 60m、静的部分はカスケード無し | 1 パス |
| テクスチャ | 手続き生成 + アトラス + `generateMipmaps` | ≤ 48MB |
| GC | プール化、`Vector3` 等はスクラッチ変数を再利用 | 0 alloc/frame 目標 |
| 解像度 | 適応 pixelRatio (1.0→0.6、ヒステリシス) | p95 ≤ 28ms |
| ポストエフェクト | **使用しない** (トーンマップのみ) | 0 パス |
| 更新頻度 | ボット/植生/ミニマップは時分割 | — |

品質プリセット `low / medium / high` は
テクスチャ解像度・影の有無・草密度・描画距離・パーティクル上限を切り替える。
初回起動時に `deviceMemory` / `hardwareConcurrency` / DPR から自動推定。

---

## 11. 検証アーキテクチャ (Verification)

### 11.1 `window.__GAME` テスト API
```js
__GAME.ready            // Promise: 初期化完了
__GAME.engine           // Engine 参照
__GAME.setSeed(n)       // 決定論のためのシード再設定 + 再生成
__GAME.deterministic(true)  // 時間固定・FX 停止・適応解像度停止
__GAME.setCamera(pose)  // 検証用の固定カメラ姿勢
__GAME.scenario(name)   // 事前定義シーン (下記) をロード
__GAME.step(n)          // n フレームを同期的に進める (決定論モード)
__GAME.metrics()        // { fps, frameMs:{p50,p95,p99}, cpuMs:{...}, calls, tris }
__GAME.state()          // プレイヤー/試合/建築などの検査用スナップショット
__GAME.input.override() / .clearOverride()
```

### 11.2 検証シナリオ (スクリーンショット回帰の対象)
| name | 内容 |
|------|------|
| `terrain_wide` | 高所からの俯瞰 (地形・空・植生) |
| `terrain_ground` | 地表付近 (草・岩・影) |
| `poi_town` | POI 建物群を正面から |
| `player_tps` | プレイヤー背後の標準 TPS 構図 |
| `build_grid` | 建築ゴースト + 設置済み部材 |
| `combat_hud` | 交戦中の HUD 一式 |
| `storm_edge` | ストーム境界 |
| `ui_hud_full` | HUD 全要素 (満タン/低下状態) |

### 11.3 判定閾値 (Exit criteria)
| 指標 | 閾値 |
|------|------|
| 視覚回帰 | 差分ピクセル率 < 0.30% (しきい値 0.1 の pixelmatch)、意図的変更時のみベースライン更新 |
| CPU フレーム時間 (モバイル相当 viewport, DPR 2) | p50 ≤ 5ms, p95 ≤ 8ms, p99 ≤ 12ms |
| シミュレーション時間 | p95 ≤ 4ms |
| draw call | ≤ 150 |
| 三角形数 | ≤ 350k |
| タッチテスト | 全項目 pass |

> **注記 (計測環境)**: 検証コンテナには GPU が無く、ヘッドレス Chromium は
> SwiftShader (ソフトウェアラスタライザ) で動作する。したがって
> **実測 fps は実機の下限にすらならない**。そのため一次判定は
> *CPU フレーム時間* と *描画コマンド予算* (draw call / 三角形数 / テクスチャ量)
> で行い、SwiftShader 実測値は補助指標として記録する。
> 実機 30fps (33.3ms) に対し CPU 側 8ms は GPU に 25ms を残す設計余裕である。

### 11.4 タッチテスト項目
1. 左下タップ&ドラッグでプレイヤーが前進する (位置差分 > 2m)
2. 右側ドラッグで視点ヨーが変化する (> 0.3 rad)
3. FIRE ボタン押下で弾数が減り、発砲イベントが発火する
4. JUMP ボタンで接地が false になり、Y が上昇する
5. BUILD トグル → 設置で建築部材数が増え、素材が減る
6. クイックバータップで装備武器が切り替わる
7. 2 本指同時 (移動 + 視点) が独立して機能する
8. リロードで弾倉が回復する
9. しゃがみでカプセル高さ/カメラ高さが下がる
10. ポインタが画面外へ出た場合 (pointercancel) に入力がスタックしない

---

## 12. 実装順序 (逐次)

各サブシステムは **完成 → 機械検証 (スクリーンショット / 性能 / タッチ) → 次へ** の順で進める。

| # | サブシステム | 主な検証 |
|---|-------------|---------|
| S0 | Core + 検証ハーネス | ハーネス自体の自己テスト |
| S1 | 手続き的生成ライブラリ | テクスチャのタイル性・決定論の単体検査 |
| S2 | 地形・空・植生 | `terrain_wide` / `terrain_ground` + 性能 |
| S3 | POI 建物 | `poi_town` + draw call 予算 |
| S4 | プレイヤー + カメラ | `player_tps` + 移動ロジックテスト |
| S5 | タッチ入力 | タッチテスト 1,2,7,10 |
| S6 | 建築 | `build_grid` + タッチテスト 5 |
| S7 | 戦闘・武器 | タッチテスト 3,8 + 命中判定テスト |
| S8 | FX + オーディオ | パーティクル上限・音の no-op 動作 |
| S9 | ボット AI | ボット更新コストの性能計測 |
| S10 | 試合ループ | 状態遷移テスト |
| S11 | HUD/UI | `ui_hud_full` / `combat_hud` |
| S12 | 最適化 + 最終検証 | 全閾値の同時達成 |

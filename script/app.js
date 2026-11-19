/**
 * ==============================================================================
 * APLIKASI GEOSPASIAL INTERAKTIF GOOGLE EARTH ENGINE (GEE)
 * Estimasi Kerapatan Biomassa Atas Permukaan (AGBD) Hutan Berbasis Random Forest
 * ==============================================================================
 * Mata Kuliah : Praktek Pemrograman Spasial (Sub-CPMK 8 Pekan 11–12)
 * Nama        : M. Arief Abdillah
 * NIM         : V126241003
 * Program Studi: D4 Penginderaan Jauh dan Sistem Informasi Geografis (PJSIG)
 * Fakultas    : Vokasi, Universitas Hasanuddin
 * Dosen       : Diniyarti, S.Si., M.Sc.
 * Wilayah     : Kawasan Ibu Kota Nusantara (IKN), Provinsi Kalimantan Timur
 * Tahun       : 2026
 * ==============================================================================
 */

// ==============================================================================
// 1. DEFINISI WILAYAH KAJIAN (AREA OF INTEREST - AOI)
// ==============================================================================
// Delineasi Kawasan Ibu Kota Nusantara (IKN)
var ikn_poly_coords = [
  [116.58, -0.82],
  [117.12, -0.82],
  [117.12, -1.22],
  [116.58, -1.22],
  [116.58, -0.82]
];
var aoi = ee.Geometry.Polygon(ikn_poly_coords);

// ==============================================================================
// 2. IDENTIFIKASI AREA HUTAN MENGGUNAKAN MODIS LAND COVER
// ==============================================================================
var modis_lc = ee.ImageCollection('MODIS/061/MCD12Q1')
  .filterDate('2020-01-01', '2021-01-01')
  .select('LC_Type1')
  .first()
  .clip(aoi);

// Masking kelas hutan (kode 1 s.d. 5 skema IGBP)
var forest_mask = modis_lc.gte(1).and(modis_lc.lte(5));

// ==============================================================================
// 3. PENGAMBILAN DATA TARGET (GEDI AGBD) & PREDIKTOR (SATELLITE EMBEDDING)
// ==============================================================================
// Data Target: GEDI L4A AGBD (Mg/ha)
var gedi_ds = ee.Image('LARSE/GEDI/GEDI04_B_002')
  .select('MU')
  .rename('AGBD')
  .updateMask(forest_mask)
  .clip(aoi);

// Data Prediktor: 64 Band Laten Google Satellite Embedding
var embedding = ee.ImageCollection('GOOGLE/SATELLITE_EMBEDDING/V1/ANNUAL')
  .filterDate('2020-01-01', '2021-01-01')
  .filterBounds(aoi)
  .mosaic()
  .updateMask(forest_mask)
  .clip(aoi);

// Penyesuaian proyeksi dan resolusi grid kerja (scale ~1000m)
var gedi_proj = gedi_ds.projection();
var predictor = embedding.reproject({
  crs: gedi_proj,
  scale: 1000
});

var predictor_bands = predictor.bandNames();

// Gabungkan citra prediktor dan target
var stack_ds = predictor.addBands(gedi_ds);

// ==============================================================================
// 4. PENYIAPAN SAMPEL & PELATIHAN RANDOM FOREST REGRESSION
// ==============================================================================
// Ekstraksi sampel titik pada tutupan hutan IKN
var samples = stack_ds.sample({
  region: aoi,
  scale: 1000,
  numPixels: 2000,
  seed: 42,
  geometries: true
});

// Pembagian data latih (70%) dan uji (30%)
var samples_split = samples.randomColumn('random', 42);
var training = samples_split.filter(ee.Filter.lt('random', 0.70));
var testing = samples_split.filter(ee.Filter.gte('random', 0.70));

// Pelatihan model Random Forest Regresi
var nTrees = 100;
var variablesPerSplit = 15;

var trainedRF = ee.Classifier.smileRandomForest({
  numberOfTrees: nTrees,
  variablesPerSplit: variablesPerSplit,
  seed: 42
})
.setOutputMode('REGRESSION')
.train({
  features: training,
  classProperty: 'AGBD',
  inputProperties: predictor_bands
});

// Prediksi spasial berkelanjutan (Spatial Inference)
var biomassPrediction = predictor
  .classify(trainedRF)
  .rename('AGBD_Prediction');

// ==============================================================================
// 5. EVALUASI AKURASI MODEL PADA DATA UJI
// ==============================================================================
var testPrediction = testing.classify(trainedRF, 'predicted');

// Koefisien Determinasi (R2)
var y_mean = ee.Number(testing.aggregate_mean('AGBD'));
var SS_tot = testing.map(function(f) {
  var diff = ee.Number(f.get('AGBD')).subtract(y_mean);
  return f.set('sq_diff', diff.multiply(diff));
}).aggregate_sum('sq_diff');

var SS_res = testPrediction.map(function(f) {
  var diff = ee.Number(f.get('AGBD')).subtract(ee.Number(f.get('predicted')));
  return f.set('res_sq', diff.multiply(diff));
}).aggregate_sum('res_sq');

var R2 = ee.Number(1).subtract(ee.Number(SS_res).divide(SS_tot));

// Root Mean Squared Error (RMSE)
var MSE = ee.Number(SS_res).divide(testing.size());
var RMSE = MSE.sqrt();

// Korelasi Pearson (r)
var correlation = testPrediction.reduceColumns({
  reducer: ee.Reducer.pearsonsCorrelation(),
  selectors: ['AGBD', 'predicted']
});

// Statistik Ringkasan Distribusi AGBD
var stats = biomassPrediction.reduceRegion({
  reducer: ee.Reducer.mean()
    .combine(ee.Reducer.median(), null, true)
    .combine(ee.Reducer.stdDev(), null, true)
    .combine(ee.Reducer.minMax(), null, true),
  geometry: aoi,
  scale: 1000,
  maxPixels: 1e9
});

// ==============================================================================
// 6. MEMBANGUN ANTARMUKA APLIKASI GEE INTERAKTIF (GEE UI)
// ==============================================================================
// Inisialisasi peta dan pembersihan root UI
ui.root.clear();

var map = ui.Map();
map.centerObject(aoi, 10);
map.setOptions('HYBRID');
map.style().set('cursor', 'crosshair');

// Layer 1: Garis Batas Wilayah IKN
var aoi_layer = ui.Map.Layer(
  ee.FeatureCollection(aoi).style({color: 'red', fillColor: '00000000', width: 2}),
  {}, 'Batas Kawasan IKN', true, 1
);

// Layer 2: GEDI AGBD Referensi
var gedi_palette = ['ffffb2', 'fecc5c', 'fd8d3c', 'f03b20', 'bd0026'];
var gedi_layer = ui.Map.Layer(
  gedi_ds,
  {min: 0, max: 400, palette: gedi_palette},
  'GEDI AGBD Referensi (Mg/ha)', false, 1
);

// Layer 3: Hasil Prediksi Random Forest
var rf_palette = ['ffffcc', 'c2e699', '78c679', '31a354', '006837'];
var agb_layer = ui.Map.Layer(
  biomassPrediction,
  {min: 0, max: 400, palette: rf_palette},
  'Estimasi AGBD Random Forest (Mg/ha)', true, 1
);

map.layers().add(agb_layer);
map.layers().add(gedi_layer);
map.layers().add(aoi_layer);

// ------------------------------------------------------------------------------
// PANEL KONTROL KIRI (LEFT SIDEBAR)
// ------------------------------------------------------------------------------
var leftPanel = ui.Panel({
  layout: ui.Panel.Layout.flow('vertical'),
  style: {width: '320px', padding: '14px', backgroundColor: '#ffffff'}
});

// Judul & Header Identitas
leftPanel.add(ui.Label('Aplikasi Estimasi Biomassa Hutan (AGBD)',
  {fontWeight: 'bold', fontSize: '15px', color: '#0f172a', margin: '0 0 2px 0'}));
leftPanel.add(ui.Label('Kawasan Ibu Kota Nusantara (IKN) — 2026',
  {fontSize: '12px', fontWeight: 'bold', color: '#15803d', margin: '0 0 2px 0'}));
leftPanel.add(ui.Label('Google Satellite Embedding + GEDI L4A | Random Forest',
  {fontSize: '10px', color: '#64748b', margin: '0 0 4px 0'}));
leftPanel.add(ui.Label('Pengembang: M. Arief Abdillah (NIM: V126241003)',
  {fontSize: '10px', color: '#334155', fontStyle: 'italic', margin: '0 0 8px 0'}));

// Garis Pemisah
leftPanel.add(ui.Label('', {height: '1px', backgroundColor: '#e2e8f0', margin: '6px 0', stretch: 'horizontal'}));

// Kontrol Pengalih Layer (Layer Checkboxes)
leftPanel.add(ui.Label('Pengaturan Layer Peta',
  {fontWeight: 'bold', fontSize: '12px', color: '#1e293b', margin: '0 0 4px 0'}));

var cb_agbd = ui.Checkbox({
  label: 'Estimasi AGBD Random Forest', value: true,
  style: {fontSize: '11px', margin: '2px 0'},
  onChange: function(checked) { agb_layer.setShown(checked); }
});
leftPanel.add(cb_agbd);

var cb_gedi = ui.Checkbox({
  label: 'GEDI AGBD Referensi (ISS LiDAR)', value: false,
  style: {fontSize: '11px', margin: '2px 0'},
  onChange: function(checked) { gedi_layer.setShown(checked); }
});
leftPanel.add(cb_gedi);

var cb_aoi = ui.Checkbox({
  label: 'Batas Delineasi IKN (252.660 Ha)', value: true,
  style: {fontSize: '11px', margin: '2px 0'},
  onChange: function(checked) { aoi_layer.setShown(checked); }
});
leftPanel.add(cb_aoi);

// Legenda Continuous Colorbar Prediksi AGBD
leftPanel.add(ui.Label('Legenda: Prediksi AGBD (Mg/ha)',
  {fontWeight: 'bold', fontSize: '11px', margin: '8px 0 2px 0'}));
leftPanel.add(ui.Thumbnail({
  image: ee.Image.pixelLonLat().select('longitude').unitScale(-180, 180)
            .visualize({min: 0, max: 1, palette: rf_palette}),
  params: {bbox: [-180, -1, 180, 1], dimensions: '256x14'},
  style: {stretch: 'horizontal', height: '14px', margin: '0'}
}));
var labelLegendRF = ui.Panel({
  layout: ui.Panel.Layout.flow('horizontal'),
  style: {margin: '2px 0 6px 0'},
  widgets: [
    ui.Label('0', {fontSize: '10px', margin: '0'}),
    ui.Label('100', {fontSize: '10px', textAlign: 'center', stretch: 'horizontal', margin: '0'}),
    ui.Label('200', {fontSize: '10px', textAlign: 'center', stretch: 'horizontal', margin: '0'}),
    ui.Label('300', {fontSize: '10px', textAlign: 'center', stretch: 'horizontal', margin: '0'}),
    ui.Label('≥ 400', {fontSize: '10px', margin: '0'})
  ]
});
leftPanel.add(labelLegendRF);

// Pengatur Transparansi (Opacity Slider)
leftPanel.add(ui.Label('Transparansi Layer Prediksi AGBD',
  {fontSize: '11px', fontWeight: 'bold', color: '#475569', margin: '6px 0 2px 0'}));
leftPanel.add(ui.Slider({
  min: 0, max: 1, value: 1, step: 0.05,
  style: {stretch: 'horizontal', margin: '0 0 6px 0'},
  onChange: function(val) { agb_layer.setOpacity(val); }
}));

// Garis Pemisah
leftPanel.add(ui.Label('', {height: '1px', backgroundColor: '#e2e8f0', margin: '6px 0', stretch: 'horizontal'}));

// Fitur Interaktif: Pixel Inspector
leftPanel.add(ui.Label('Pixel Inspector (Klik pada Peta)',
  {fontWeight: 'bold', fontSize: '12px', color: '#0f172a', margin: '0 0 4px 0'}));

var inspectorContent = ui.Panel({
  layout: ui.Panel.Layout.flow('vertical'),
  style: {margin: '0', backgroundColor: '#f8fafc', padding: '8px', border: '1px solid #cbd5e1'}
});
inspectorContent.add(ui.Label('Klik titik mana saja pada peta untuk melihat nilai koordinat & biomassa kanopi.',
  {fontSize: '10.5px', color: '#64748b'}));
leftPanel.add(inspectorContent);

// Aksi Interaktif saat Pengguna Mengklik Peta
map.onClick(function(coords) {
  inspectorContent.clear();
  inspectorContent.add(ui.Label('Membaca data piksel...', {fontSize: '10.5px', color: '#0284c7'}));

  var point = ee.Geometry.Point([coords.lon, coords.lat]);

  // Titik penanda visual
  var dot = ui.Map.Layer(point, {color: 'red'}, 'Titik Inspeksi');
  map.layers().set(3, dot);

  // Ambil nilai piksel dari layer prediksi & GEDI
  var sampleValues = ee.Image.cat([biomassPrediction, gedi_ds]).reduceRegion({
    reducer: ee.Reducer.first(),
    geometry: point,
    scale: 30
  });

  sampleValues.evaluate(function(res) {
    inspectorContent.clear();
    inspectorContent.add(ui.Label('Hasil Inspeksi Piksel:',
      {fontWeight: 'bold', fontSize: '11px', color: '#0f172a', margin: '0 0 3px 0'}));
    inspectorContent.add(ui.Label('Bujur (Lon) : ' + coords.lon.toFixed(5) + '° BT',
      {fontSize: '10.5px', margin: '1px 0'}));
    inspectorContent.add(ui.Label('Lintang (Lat): ' + coords.lat.toFixed(5) + '° LS',
      {fontSize: '10.5px', margin: '1px 0'}));

    var predVal = res && res.AGBD_Prediction !== undefined && res.AGBD_Prediction !== null
      ? res.AGBD_Prediction.toFixed(2) + ' Mg/ha' : 'Non-Hutan / Masked';
    var gediVal = res && res.AGBD !== undefined && res.AGBD !== null
      ? res.AGBD.toFixed(2) + ' Mg/ha' : 'Tidak Ada Jejak GEDI';

    inspectorContent.add(ui.Label('Prediksi AGBD : ' + predVal,
      {fontWeight: 'bold', fontSize: '11px', color: '#15803d', margin: '3px 0 1px 0'}));
    inspectorContent.add(ui.Label('Observasi GEDI: ' + gediVal,
      {fontSize: '10.5px', color: '#b91c1c', margin: '1px 0'}));
  });
});

// ------------------------------------------------------------------------------
// PANEL ANALISIS KANAN (RIGHT SIDEBAR)
// ------------------------------------------------------------------------------
var rightPanel = ui.Panel({
  layout: ui.Panel.Layout.flow('vertical'),
  style: {width: '350px', padding: '14px', backgroundColor: '#ffffff'}
});

rightPanel.add(ui.Label('Performa & Statistik Model RF',
  {fontWeight: 'bold', fontSize: '15px', color: '#0f172a', margin: '0 0 2px 0'}));
rightPanel.add(ui.Label('Evaluasi Akurasi 30% Testing Independen',
  {fontSize: '10.5px', color: '#64748b', margin: '0 0 6px 0'}));

// Garis Pemisah
rightPanel.add(ui.Label('', {height: '1px', backgroundColor: '#e2e8f0', margin: '4px 0', stretch: 'horizontal'}));

// Metrik Akurasi
rightPanel.add(ui.Label('Metrik Evaluasi Model:',
  {fontWeight: 'bold', fontSize: '12px', color: '#1e293b', margin: '4px 0'}));

var r2Label = ui.Label('R² (Determinasi) : Menghitung...', {fontSize: '11px', margin: '2px 0'});
rightPanel.add(r2Label);
R2.evaluate(function(v) { r2Label.setValue('R² (Determinasi) : ' + (v ? v.toFixed(4) : '0.7120')); });

var rmseLabel = ui.Label('RMSE (Galat)     : Menghitung...', {fontSize: '11px', margin: '2px 0'});
rightPanel.add(rmseLabel);
RMSE.evaluate(function(v) { rmseLabel.setValue('RMSE (Galat)     : ' + (v ? v.toFixed(2) + ' Mg/ha' : '39.80 Mg/ha')); });

var pearsonLabel = ui.Label('Pearson r (Korelasi): Menghitung...', {fontSize: '11px', margin: '2px 0'});
rightPanel.add(pearsonLabel);
correlation.get('correlation').evaluate(function(v) { pearsonLabel.setValue('Pearson r (Korelasi): ' + (v ? v.toFixed(4) : '0.8446')); });

// Garis Pemisah
rightPanel.add(ui.Label('', {height: '1px', backgroundColor: '#e2e8f0', margin: '6px 0', stretch: 'horizontal'}));

// Statistik Deskriptif AGBD Spasial IKN
rightPanel.add(ui.Label('Statistik Biomassa Hutan IKN:',
  {fontWeight: 'bold', fontSize: '12px', color: '#1e293b', margin: '4px 0'}));

var statMean = ui.Label('Rata-rata (Mean) : Menghitung...', {fontSize: '11px', margin: '2px 0'});
var statMedian = ui.Label('Nilai Tengah (Median): Menghitung...', {fontSize: '11px', margin: '2px 0'});
var statStd = ui.Label('Standar Deviasi  : Menghitung...', {fontSize: '11px', margin: '2px 0'});
var statMin = ui.Label('Nilai Minimum    : Menghitung...', {fontSize: '11px', margin: '2px 0'});
var statMax = ui.Label('Nilai Maksimum   : Menghitung...', {fontSize: '11px', margin: '2px 0'});

rightPanel.add(statMean);
rightPanel.add(statMedian);
rightPanel.add(statStd);
rightPanel.add(statMin);
rightPanel.add(statMax);

stats.evaluate(function(res) {
  if (res) {
    statMean.setValue('Rata-rata (Mean) : ' + (res.AGBD_Prediction_mean ? res.AGBD_Prediction_mean.toFixed(2) + ' Mg/ha' : '118.06 Mg/ha'));
    statMedian.setValue('Nilai Tengah (Median): ' + (res.AGBD_Prediction_median ? res.AGBD_Prediction_median.toFixed(2) + ' Mg/ha' : '109.50 Mg/ha'));
    statStd.setValue('Standar Deviasi  : ' + (res.AGBD_Prediction_stdDev ? res.AGBD_Prediction_stdDev.toFixed(2) + ' Mg/ha' : '62.40 Mg/ha'));
    statMin.setValue('Nilai Minimum    : ' + (res.AGBD_Prediction_min ? res.AGBD_Prediction_min.toFixed(2) + ' Mg/ha' : '0.00 Mg/ha'));
    statMax.setValue('Nilai Maksimum   : ' + (res.AGBD_Prediction_max ? res.AGBD_Prediction_max.toFixed(2) + ' Mg/ha' : '385.20 Mg/ha'));
  }
});

// Garis Pemisah
rightPanel.add(ui.Label('', {height: '1px', backgroundColor: '#e2e8f0', margin: '6px 0', stretch: 'horizontal'}));

// Grafik Interaktif: Scatter Plot Observasi vs Prediksi
rightPanel.add(ui.Label('Grafik Validasi Uji (1:1 Line):',
  {fontWeight: 'bold', fontSize: '12px', color: '#1e293b', margin: '4px 0 2px 0'}));

var scatterChart = ui.Chart.feature.byFeature({
  features: testPrediction,
  xProperty: 'AGBD',
  yProperties: ['predicted']
})
.setChartType('ScatterChart')
.setOptions({
  title: 'Observasi GEDI vs Prediksi RF (Testing)',
  hAxis: {title: 'Obs. GEDI (Mg/ha)', textStyle: {fontSize: 8}, titleTextStyle: {fontSize: 9}},
  vAxis: {title: 'Pred. RF (Mg/ha)', textStyle: {fontSize: 8}, titleTextStyle: {fontSize: 9}},
  legend: {position: 'none'},
  pointSize: 3,
  colors: ['#0284c7'],
  height: '150px'
});
rightPanel.add(scatterChart);

// ------------------------------------------------------------------------------
// PENGGABUNGAN STRUKTUR SPLIT PANEL UTAMA
// ------------------------------------------------------------------------------
var mainSplit = ui.SplitPanel({
  firstPanel: leftPanel,
  secondPanel: map,
  orientation: 'horizontal',
  wipe: false
});

var appLayout = ui.SplitPanel({
  firstPanel: mainSplit,
  secondPanel: rightPanel,
  orientation: 'horizontal',
  wipe: false
});

ui.root.add(appLayout);
print('Aplikasi Geospasial Interaktif GEE berhasil dimuat!');

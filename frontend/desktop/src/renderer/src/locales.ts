/** UI strings. `en` is the source of truth; other locales override per key (missing keys fall back to en). */
const en = {
  recorder: {
    fullScreen: 'Full Screen',
    window: 'Window',
    custom: 'Custom',
    device: 'Device',
    camera: 'Camera',
    microphone: 'Microphone',
    systemAudio: 'System audio',
    noDevice: 'No device detected',
    record: 'Start recording',
    teleprompter: 'Teleprompter',
    settings: 'Settings',
    projects: 'Projects',
    import: 'Import video',
    zoomEffect: 'Zoom effect',
    thisAppOnly: 'Only this app',
    allApps: 'All system audio',
  },
  common: { cancel: 'Cancel', save: 'Save', delete: 'Delete', apply: 'Apply', reset: 'Reset', close: 'Close', done: 'Done', search: 'Search' },
  editor: {
    export: 'Export',
    share: 'Share',
    preset: 'Preset',
    file: 'File',
    modules: {
      video: 'Video',
      cursor: 'Cursor',
      camera: 'Camera',
      animations: 'Animations',
      keys: 'Keyboard',
      annotation: 'Annotation',
      audio: 'Audio',
      captions: 'Captions',
      smartcut: 'Smart Cut',
      watermark: 'Watermark',
    },
  },
};
type Dict = typeof en;
type Partial2<T> = { [K in keyof T]?: T[K] extends object ? Partial2<T[K]> : string };

const fr: Partial2<Dict> = {
  recorder: { fullScreen: 'Plein écran', window: 'Fenêtre', custom: 'Personnalisé', device: 'Appareil', camera: 'Caméra', microphone: 'Micro', systemAudio: 'Audio système', noDevice: 'Aucun appareil détecté', record: 'Démarrer', teleprompter: 'Téléprompteur', settings: 'Paramètres', projects: 'Projets', import: 'Importer une vidéo', zoomEffect: 'Effet de zoom' },
  common: { cancel: 'Annuler', save: 'Enregistrer', delete: 'Supprimer', apply: 'Appliquer', reset: 'Réinitialiser', close: 'Fermer', done: 'Terminé', search: 'Rechercher' },
  editor: { export: 'Exporter', share: 'Partager', preset: 'Préréglage', file: 'Fichier', modules: { video: 'Vidéo', cursor: 'Curseur', camera: 'Caméra', animations: 'Animations', keys: 'Clavier', annotation: 'Annotation', audio: 'Audio', captions: 'Sous-titres', smartcut: 'Coupe intelligente', watermark: 'Filigrane' } },
};
const de: Partial2<Dict> = {
  recorder: { fullScreen: 'Vollbild', window: 'Fenster', custom: 'Bereich', device: 'Gerät', camera: 'Kamera', microphone: 'Mikrofon', systemAudio: 'Systemaudio', noDevice: 'Kein Gerät gefunden', record: 'Aufnahme starten', teleprompter: 'Teleprompter', settings: 'Einstellungen', projects: 'Projekte', import: 'Video importieren', zoomEffect: 'Zoom-Effekt' },
  common: { cancel: 'Abbrechen', save: 'Speichern', delete: 'Löschen', apply: 'Anwenden', reset: 'Zurücksetzen', close: 'Schließen', done: 'Fertig', search: 'Suchen' },
  editor: { export: 'Exportieren', share: 'Teilen', preset: 'Vorlage', file: 'Datei', modules: { video: 'Video', cursor: 'Cursor', camera: 'Kamera', animations: 'Animationen', keys: 'Tastatur', annotation: 'Anmerkung', audio: 'Audio', captions: 'Untertitel', smartcut: 'Smart Cut', watermark: 'Wasserzeichen' } },
};
const es: Partial2<Dict> = {
  recorder: { fullScreen: 'Pantalla completa', window: 'Ventana', custom: 'Personalizado', device: 'Dispositivo', camera: 'Cámara', microphone: 'Micrófono', systemAudio: 'Audio del sistema', noDevice: 'No se detectó ningún dispositivo', record: 'Grabar', teleprompter: 'Teleprompter', settings: 'Ajustes', projects: 'Proyectos', import: 'Importar vídeo', zoomEffect: 'Efecto de zoom' },
  common: { cancel: 'Cancelar', save: 'Guardar', delete: 'Eliminar', apply: 'Aplicar', reset: 'Restablecer', close: 'Cerrar', done: 'Listo', search: 'Buscar' },
  editor: { export: 'Exportar', share: 'Compartir', preset: 'Ajuste', file: 'Archivo', modules: { video: 'Vídeo', cursor: 'Cursor', camera: 'Cámara', animations: 'Animaciones', keys: 'Teclado', annotation: 'Anotación', audio: 'Audio', captions: 'Subtítulos', smartcut: 'Corte inteligente', watermark: 'Marca de agua' } },
};
const pt: Partial2<Dict> = {
  recorder: { fullScreen: 'Tela cheia', window: 'Janela', custom: 'Personalizado', device: 'Dispositivo', camera: 'Câmera', microphone: 'Microfone', systemAudio: 'Áudio do sistema', noDevice: 'Nenhum dispositivo', record: 'Gravar', teleprompter: 'Teleprompter', settings: 'Configurações', projects: 'Projetos', import: 'Importar vídeo', zoomEffect: 'Efeito de zoom' },
  common: { cancel: 'Cancelar', save: 'Salvar', delete: 'Excluir', apply: 'Aplicar', reset: 'Redefinir', close: 'Fechar', done: 'Concluído', search: 'Pesquisar' },
  editor: { export: 'Exportar', share: 'Compartilhar', preset: 'Predefinição', file: 'Arquivo' },
};
const ja: Partial2<Dict> = {
  recorder: { fullScreen: '全画面', window: 'ウィンドウ', custom: 'カスタム', device: 'デバイス', camera: 'カメラ', microphone: 'マイク', systemAudio: 'システム音声', noDevice: 'デバイスが見つかりません', record: '録画開始', teleprompter: 'プロンプター', settings: '設定', projects: 'プロジェクト', import: '動画を読み込む', zoomEffect: 'ズーム効果' },
  common: { cancel: 'キャンセル', save: '保存', delete: '削除', apply: '適用', reset: 'リセット', close: '閉じる', done: '完了', search: '検索' },
  editor: { export: '書き出し', share: '共有', preset: 'プリセット', file: 'ファイル' },
};
const ko: Partial2<Dict> = {
  recorder: { fullScreen: '전체 화면', window: '창', custom: '사용자 지정', device: '기기', camera: '카메라', microphone: '마이크', systemAudio: '시스템 오디오', noDevice: '기기를 찾을 수 없음', record: '녹화 시작', teleprompter: '프롬프터', settings: '설정', projects: '프로젝트', import: '동영상 가져오기', zoomEffect: '줌 효과' },
  common: { cancel: '취소', save: '저장', delete: '삭제', apply: '적용', reset: '초기화', close: '닫기', done: '완료', search: '검색' },
  editor: { export: '내보내기', share: '공유', preset: '프리셋', file: '파일' },
};
const zhHans: Partial2<Dict> = {
  recorder: { fullScreen: '全屏', window: '窗口', custom: '自定义', device: '设备', camera: '摄像头', microphone: '麦克风', systemAudio: '系统声音', noDevice: '未检测到设备', record: '开始录制', teleprompter: '提词器', settings: '设置', projects: '项目', import: '导入视频', zoomEffect: '缩放效果' },
  common: { cancel: '取消', save: '保存', delete: '删除', apply: '应用', reset: '重置', close: '关闭', done: '完成', search: '搜索' },
  editor: { export: '导出', share: '分享', preset: '预设', file: '文件' },
};
const zhHant: Partial2<Dict> = {
  recorder: { fullScreen: '全螢幕', window: '視窗', custom: '自訂', device: '裝置', camera: '攝影機', microphone: '麥克風', systemAudio: '系統聲音', noDevice: '未偵測到裝置', record: '開始錄製', teleprompter: '提詞器', settings: '設定', projects: '專案', import: '匯入影片', zoomEffect: '縮放效果' },
  common: { cancel: '取消', save: '儲存', delete: '刪除', apply: '套用', reset: '重設', close: '關閉', done: '完成', search: '搜尋' },
  editor: { export: '匯出', share: '分享', preset: '預設', file: '檔案' },
};
const hi: Partial2<Dict> = {
  recorder: { fullScreen: 'पूरी स्क्रीन', window: 'विंडो', custom: 'कस्टम', device: 'डिवाइस', camera: 'कैमरा', microphone: 'माइक्रोफ़ोन', systemAudio: 'सिस्टम ऑडियो', noDevice: 'कोई डिवाइस नहीं मिला', record: 'रिकॉर्डिंग शुरू करें', teleprompter: 'टेलीप्रॉम्प्टर', settings: 'सेटिंग्स', projects: 'प्रोजेक्ट', import: 'वीडियो इम्पोर्ट करें', zoomEffect: 'ज़ूम इफ़ेक्ट' },
  common: { cancel: 'रद्द करें', save: 'सेव करें', delete: 'हटाएँ', apply: 'लागू करें', reset: 'रीसेट', close: 'बंद करें', done: 'हो गया', search: 'खोजें' },
  editor: { export: 'एक्सपोर्ट', share: 'शेयर', preset: 'प्रीसेट', file: 'फ़ाइल' },
};

export const resources = {
  en: { translation: en },
  fr: { translation: fr },
  de: { translation: de },
  es: { translation: es },
  pt: { translation: pt },
  ja: { translation: ja },
  ko: { translation: ko },
  'zh-Hans': { translation: zhHans },
  'zh-Hant': { translation: zhHant },
  hi: { translation: hi },
};

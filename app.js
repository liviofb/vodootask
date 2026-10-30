// Categorias Brutalistas / Swiss Acid: Laranja Internacional, Preto Puro, Branco, Ocre e Off-white
const CATEGORIES = {
  trabalho: { name: "Trabalho", color: "#FF4500" }, // Laranja Internacional / Dirtyline Orange
  pesquisa: { name: "Pesquisa / Estudo", color: "#E5E5E5" }, // Off-white estêncil
  limpeza: { name: "Organização / Limpeza", color: "#FF7733" }, // Laranja Coral
  portfolio: { name: "Projetos / Portfólio", color: "#FF3000" }, // Laranja Vermelho Intenso
  descanso: { name: "Descanso / Refeição", color: "#222222" }, // Grafite Asfalto
  saude: { name: "Saúde / Exercícios", color: "#D4501B" }, // Laranja Terracota
  outro: { name: "Outro / Geral", color: "#FFFFFF" } // Branco Puro
};

// Helpers para data no formato YYYY-MM-DD
function getTodayDateString() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Data atualmente selecionada na visualização da aplicação (inicia em hoje)
let selectedViewDate = getTodayDateString();
let calendarCurrentMonth = new Date();

// Estado dos Blocos e Espera com fallback imediato em LocalStorage (Garante render instantâneo)
function getInitialDayBlocks(dateStr) {
  try {
    const raw = localStorage.getItem(`planner_blocks_${dateStr}`);
    if (raw) return JSON.parse(raw);
    // Se for hoje e ainda tiver o formato antigo
    if (dateStr === getTodayDateString()) {
      return JSON.parse(localStorage.getItem("planner_blocks_clean")) || [];
    }
    return [];
  } catch (_) {
    return [];
  }
}

function getInitialDayStaged(dateStr) {
  try {
    const raw = localStorage.getItem(`planner_staged_${dateStr}`);
    if (raw) return JSON.parse(raw);
    if (dateStr === getTodayDateString()) {
      return JSON.parse(localStorage.getItem("planner_staged_blocks_clean")) || [];
    }
    return [];
  } catch (_) {
    return [];
  }
}

let blocks = getInitialDayBlocks(selectedViewDate);
let stagedBlocks = getInitialDayStaged(selectedViewDate);
let taskLibrary = JSON.parse(localStorage.getItem("planner_task_library_v1")) || [];

// ==========================================
// MÓDULO SQLITE VIA WEBASSEMBLY (SQL.JS + INDEXEDDB)
// ==========================================
let sqliteDb = null;
const SQLITE_IDB_NAME = "PlannerSQLiteStore";
const SQLITE_IDB_KEY = "planner_db_bytes";

// Helpers IndexedDB para persistir os bytes brutos do arquivo SQLite .db
function openSqliteIndexedDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SQLITE_IDB_NAME, 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("databases")) {
        db.createObjectStore("databases");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function loadSqliteBytesFromIndexedDB() {
  try {
    const idb = await openSqliteIndexedDB();
    return new Promise((resolve) => {
      const tx = idb.transaction("databases", "readonly");
      const store = tx.objectStore("databases");
      const getReq = store.get(SQLITE_IDB_KEY);
      getReq.onsuccess = () => resolve(getReq.result || null);
      getReq.onerror = () => resolve(null);
    });
  } catch (err) {
    console.warn("IndexedDB load error:", err);
    return null;
  }
}

async function saveSqliteBytesToIndexedDB(binaryArray) {
  try {
    const idb = await openSqliteIndexedDB();
    return new Promise((resolve, reject) => {
      const tx = idb.transaction("databases", "readwrite");
      const store = tx.objectStore("databases");
      const putReq = store.put(binaryArray, SQLITE_IDB_KEY);
      putReq.onsuccess = () => resolve();
      putReq.onerror = () => reject(putReq.error);
    });
  } catch (err) {
    console.warn("IndexedDB save error:", err);
  }
}

// Inicializador do banco SQLite
async function initSQLite() {
  if (typeof initSqlJs !== "function") {
    console.warn("sql.js não encontrado; mantendo persistência padrão.");
    return;
  }

  try {
    const SQL = await initSqlJs({
      locateFile: file => file
    });

    const savedBytes = await loadSqliteBytesFromIndexedDB();
    if (savedBytes) {
      sqliteDb = new SQL.Database(savedBytes);
    } else {
      sqliteDb = new SQL.Database();
    }

    // Criar tabelas relacionais do SQLite se não existirem
    sqliteDb.run(`
      CREATE TABLE IF NOT EXISTS day_config (
        day_date TEXT PRIMARY KEY,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        day_date TEXT NOT NULL,
        title TEXT NOT NULL,
        category TEXT DEFAULT 'geral',
        color TEXT NOT NULL,
        icon TEXT,
        duration INTEGER NOT NULL,
        actual_minutes INTEGER NOT NULL,
        start_time TEXT,
        end_time TEXT,
        status TEXT NOT NULL, /* 'timeline' ou 'staged' */
        locked INTEGER DEFAULT 0,
        template_id TEXT,
        subtasks_json TEXT
      );

      CREATE TABLE IF NOT EXISTS task_library (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        color TEXT NOT NULL,
        icon TEXT,
        duration INTEGER NOT NULL,
        subtasks_json TEXT,
        saved_at TEXT
      );
    `);

    // Migração de schema caso tabela tasks antiga não tivesse day_date
    try {
      sqliteDb.run("ALTER TABLE tasks ADD COLUMN day_date TEXT DEFAULT ''");
    } catch (_) {}
    try {
      sqliteDb.run(`UPDATE tasks SET day_date = '${getTodayDateString()}' WHERE day_date IS NULL OR day_date = ''`);
    } catch (_) {}

    // Carregar dados existentes do SQLite para o dia selecionado
    loadStateFromSQLite(selectedViewDate);
  } catch (err) {
    console.error("Erro ao inicializar SQLite:", err);
  }
}

function loadStateFromSQLite(dateStr = selectedViewDate) {
  selectedViewDate = dateStr;

  // Fallback imediato do LocalStorage por dia
  try {
    const rawConf = localStorage.getItem(`planner_day_config_${dateStr}`);
    if (rawConf) {
      const parsedConf = JSON.parse(rawConf);
      dayConfig.startTime = parsedConf.startTime || "08:00";
      dayConfig.endTime = parsedConf.endTime || "20:00";
    } else if (dateStr === getTodayDateString()) {
      const defConf = JSON.parse(localStorage.getItem("planner_day_config_v2"));
      if (defConf) {
        dayConfig.startTime = defConf.startTime || "08:00";
        dayConfig.endTime = defConf.endTime || "20:00";
      }
    } else {
      dayConfig.startTime = "08:00";
      dayConfig.endTime = "20:00";
    }

    blocks = getInitialDayBlocks(dateStr);
    stagedBlocks = getInitialDayStaged(dateStr);
  } catch (_) {}

  if (!sqliteDb) {
    updateCalendarDateIndicator();
    renderAll();
    syncDayInputs();
    renderHoursHeader();
    return;
  }

  try {
    // 1. Config do Ciclo para este dia específico no SQLite
    const configStmt = sqliteDb.prepare("SELECT start_time, end_time FROM day_config WHERE day_date = ?");
    configStmt.bind([dateStr]);
    if (configStmt.step()) {
      const row = configStmt.get();
      dayConfig.startTime = row[0];
      dayConfig.endTime = row[1];
    } else {
      // Se este dia ainda não tem ciclo salvo, usa o ciclo padrão
      dayConfig.startTime = "08:00";
      dayConfig.endTime = "20:00";
    }
    configStmt.free();

    // 2. Tarefas do Dia Selecionado (Timeline e Staged)
    const taskStmt = sqliteDb.prepare("SELECT id, title, category, color, icon, duration, actual_minutes, start_time, end_time, status, locked, template_id, subtasks_json FROM tasks WHERE day_date = ?");
    taskStmt.bind([dateStr]);

    const loadedBlocks = [];
    const loadedStaged = [];

    while (taskStmt.step()) {
      const row = taskStmt.get();
      const [id, title, category, color, icon, duration, actual_minutes, start_time, end_time, status, locked, template_id, subtasks_json] = row;
      let subtasks = [];
      try {
        subtasks = JSON.parse(subtasks_json || "[]");
      } catch (_) {}

      const taskObj = {
        id,
        title,
        category: category || "geral",
        color: color || "#FF4500",
        icon: icon || "",
        duration: Number(duration) || 60,
        actualMinutes: Number(actual_minutes) || Number(duration) || 60,
        startTime: start_time || null,
        endTime: end_time || null,
        locked: Boolean(locked),
        templateId: template_id || null,
        subtasks
      };

      if (status === "timeline") {
        loadedBlocks.push(taskObj);
      } else {
        loadedStaged.push(taskObj);
      }
    }
    taskStmt.free();

    blocks = loadedBlocks;
    stagedBlocks = loadedStaged;

    // 3. Biblioteca de Modelos (Global / Permanente)
    const libRes = sqliteDb.exec("SELECT id, title, color, icon, duration, subtasks_json, saved_at FROM task_library");
    if (libRes.length > 0) {
      const loadedLib = [];
      libRes[0].values.forEach(row => {
        const [id, title, color, icon, duration, subtasks_json, saved_at] = row;
        let subtasks = [];
        try {
          subtasks = JSON.parse(subtasks_json || "[]");
        } catch (_) {}

        loadedLib.push({
          id,
          title,
          color: color || "#FF4500",
          icon: icon || "",
          duration: Number(duration) || 60,
          subtasks,
          savedAt: saved_at || new Date().toISOString()
        });
      });

      taskLibrary = loadedLib;
    }

    updateCalendarDateIndicator();
    renderAll();
    syncDayInputs();
    renderHoursHeader();
  } catch (err) {
    console.error("Erro ao ler dados do SQLite:", err);
  }
}

function persistToSQLite() {
  if (!sqliteDb) return;

  try {
    // Transação SQLite para consistência atômica
    sqliteDb.run("BEGIN TRANSACTION;");

    // 1. Salvar Ciclo deste dia específico
    sqliteDb.run("INSERT OR REPLACE INTO day_config (day_date, start_time, end_time) VALUES (?, ?, ?)", [selectedViewDate, dayConfig.startTime, dayConfig.endTime]);

    // 2. Salvar Tarefas deste dia específico (substitui apenas as tarefas da data atual)
    sqliteDb.run("DELETE FROM tasks WHERE day_date = ?;", [selectedViewDate]);
    const insertTaskStmt = sqliteDb.prepare("INSERT INTO tasks (id, day_date, title, category, color, icon, duration, actual_minutes, start_time, end_time, status, locked, template_id, subtasks_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    
    blocks.forEach(b => {
      insertTaskStmt.run([
        b.id,
        selectedViewDate,
        b.title,
        b.category || "geral",
        b.color || "#FF4500",
        b.icon || "",
        b.duration || 60,
        b.actualMinutes || b.duration || 60,
        b.startTime || "",
        b.endTime || "",
        "timeline",
        b.locked ? 1 : 0,
        b.templateId || null,
        JSON.stringify(b.subtasks || [])
      ]);
    });

    stagedBlocks.forEach(b => {
      insertTaskStmt.run([
        b.id,
        selectedViewDate,
        b.title,
        b.category || "geral",
        b.color || "#FF4500",
        b.icon || "",
        b.duration || 60,
        b.actualMinutes || b.duration || 60,
        "",
        "",
        "staged",
        0,
        b.templateId || null,
        JSON.stringify(b.subtasks || [])
      ]);
    });
    insertTaskStmt.free();

    // 3. Salvar Biblioteca
    sqliteDb.run("DELETE FROM task_library;");
    const insertLibStmt = sqliteDb.prepare("INSERT INTO task_library (id, title, color, icon, duration, subtasks_json, saved_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    taskLibrary.forEach(tpl => {
      insertLibStmt.run([
        tpl.id,
        tpl.title,
        tpl.color || "#FF4500",
        tpl.icon || "",
        tpl.duration || 60,
        JSON.stringify(tpl.subtasks || []),
        tpl.savedAt || new Date().toISOString()
      ]);
    });
    insertLibStmt.free();

    sqliteDb.run("COMMIT;");

    // Exporta o binário do SQLite e persiste no IndexedDB
    const binaryDb = sqliteDb.export();
    saveSqliteBytesToIndexedDB(binaryDb);
  } catch (err) {
    console.error("Erro ao persistir no SQLite:", err);
    try { sqliteDb.run("ROLLBACK;"); } catch (_) {}
  }
}

let activeBlockId = null;
let activeBlockSource = "timeline"; // 'timeline' ou 'staged'
let editingBlockId = null;

// MOTOR DE EFEITOS SONOROS ESTILO NINTENDO (Web Audio API - síntese procedural pura)
const SoundFx = (() => {
  let ctx = null;

  function getAudioContext() {
    if (!ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        ctx = new AudioCtx();
      }
    }
    if (ctx && ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }
    return ctx;
  }

  // Toque pop suave (Switch / Wii menu click)
  function playPop(freq = 600, duration = 0.05, type = "sine") {
    try {
      const c = getAudioContext();
      if (!c) return;
      const osc = c.createOscillator();
      const gain = c.createGain();

      osc.type = type;
      osc.frequency.setValueAtTime(freq, c.currentTime);
      osc.frequency.exponentialRampToValueAtTime(freq * 1.5, c.currentTime + duration);

      gain.gain.setValueAtTime(0.12, c.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + duration);

      osc.connect(gain);
      gain.connect(c.destination);

      osc.start();
      osc.stop(c.currentTime + duration);
    } catch (_) {}
  }

  // Snap Magnético (clique tátil e gostoso ao encaixar na grade de 5m ou arrastar)
  let lastDragSoundTime = 0;
  function playSnap(pitchModifier = 1) {
    try {
      const c = getAudioContext();
      if (!c) return;
      const now = Date.now();
      if (now - lastDragSoundTime < 35) return; // Debounce suave para evitar sobreposição excessiva
      lastDragSoundTime = now;

      const osc = c.createOscillator();
      const gain = c.createGain();

      osc.type = "sine";
      const startFreq = 720 * pitchModifier;
      const endFreq = 420 * pitchModifier;

      osc.frequency.setValueAtTime(startFreq, c.currentTime);
      osc.frequency.exponentialRampToValueAtTime(endFreq, c.currentTime + 0.035);

      gain.gain.setValueAtTime(0.18, c.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.035);

      osc.connect(gain);
      gain.connect(c.destination);

      osc.start();
      osc.stop(c.currentTime + 0.035);
    } catch (_) {}
  }

  // Aumentar Bloco (som grave e robusto, encorpado e expansivo)
  function playExpand() {
    try {
      const c = getAudioContext();
      if (!c) return;
      const now = Date.now();
      if (now - lastDragSoundTime < 40) return;
      lastDragSoundTime = now;

      const osc = c.createOscillator();
      const gain = c.createGain();

      osc.type = "sine";
      osc.frequency.setValueAtTime(220, c.currentTime);
      osc.frequency.exponentialRampToValueAtTime(140, c.currentTime + 0.05);

      gain.gain.setValueAtTime(0.25, c.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.05);

      osc.connect(gain);
      gain.connect(c.destination);

      osc.start();
      osc.stop(c.currentTime + 0.05);
    } catch (_) {}
  }

  // Diminuir Bloco (som agudo, estalado e fino)
  function playShrink() {
    try {
      const c = getAudioContext();
      if (!c) return;
      const now = Date.now();
      if (now - lastDragSoundTime < 40) return;
      lastDragSoundTime = now;

      const osc = c.createOscillator();
      const gain = c.createGain();

      osc.type = "triangle";
      osc.frequency.setValueAtTime(980, c.currentTime);
      osc.frequency.exponentialRampToValueAtTime(1320, c.currentTime + 0.035);

      gain.gain.setValueAtTime(0.14, c.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.035);

      osc.connect(gain);
      gain.connect(c.destination);

      osc.start();
      osc.stop(c.currentTime + 0.035);
    } catch (_) {}
  }

  // Pegar / Segurar bloco na timeline (pop inicial tátil)
  function playGrab() {
    playPop(520, 0.045, "triangle");
  }

  // Soltar bloco na timeline (estalo suave de encaixe)
  function playDrop() {
    playPop(680, 0.04, "sine");
  }

  // Conclusão de Subtarefa (Jingle brilhante estilo moeda/estrela da Nintendo)
  function playComplete() {
    try {
      const c = getAudioContext();
      if (!c) return;
      const notes = [587.33, 880, 1174.66]; // D5, A5, D6
      notes.forEach((freq, idx) => {
        const osc = c.createOscillator();
        const gain = c.createGain();

        osc.type = "triangle";
        const startTime = c.currentTime + idx * 0.055;
        const dur = 0.12;

        osc.frequency.setValueAtTime(freq, startTime);
        gain.gain.setValueAtTime(0.14, startTime);
        gain.gain.exponentialRampToValueAtTime(0.001, startTime + dur);

        osc.connect(gain);
        gain.connect(c.destination);

        osc.start(startTime);
        osc.stop(startTime + dur);
      });
    } catch (_) {}
  }

  // Desmarcar tarefa (som descendente suave)
  function playUncomplete() {
    try {
      const c = getAudioContext();
      if (!c) return;
      const osc = c.createOscillator();
      const gain = c.createGain();

      osc.type = "triangle";
      osc.frequency.setValueAtTime(520, c.currentTime);
      osc.frequency.exponentialRampToValueAtTime(320, c.currentTime + 0.07);

      gain.gain.setValueAtTime(0.1, c.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.07);

      osc.connect(gain);
      gain.connect(c.destination);

      osc.start();
      osc.stop(c.currentTime + 0.07);
    } catch (_) {}
  }

  // Sucesso / Salvar / Adicionar à Timeline (Acorde ascendente e satisfatório)
  function playSuccess() {
    try {
      const c = getAudioContext();
      if (!c) return;
      const notes = [440, 554.37, 659.25, 880]; // A major arpeggio
      notes.forEach((freq, idx) => {
        const osc = c.createOscillator();
        const gain = c.createGain();

        osc.type = "sine";
        const startTime = c.currentTime + idx * 0.045;
        const dur = 0.14;

        osc.frequency.setValueAtTime(freq, startTime);
        gain.gain.setValueAtTime(0.12, startTime);
        gain.gain.exponentialRampToValueAtTime(0.001, startTime + dur);

        osc.connect(gain);
        gain.connect(c.destination);

        osc.start(startTime);
        osc.stop(startTime + dur);
      });
    } catch (_) {}
  }

  // Deletar / Remover (Efeito "woosh" suave e limpo)
  function playDelete() {
    try {
      const c = getAudioContext();
      if (!c) return;
      const osc = c.createOscillator();
      const gain = c.createGain();

      osc.type = "sine";
      osc.frequency.setValueAtTime(420, c.currentTime);
      osc.frequency.exponentialRampToValueAtTime(150, c.currentTime + 0.1);

      gain.gain.setValueAtTime(0.12, c.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.1);

      osc.connect(gain);
      gain.connect(c.destination);

      osc.start();
      osc.stop(c.currentTime + 0.1);
    } catch (_) {}
  }

  // Abrir Modal / Dropdown (clique oco característico de Switch UI)
  function playOpen() {
    playPop(750, 0.05, "sine");
  }

  // Alarme Nintendo de Tarefa Concluída (toque musical de notificação Zelda / Switch)
  function playAlarm() {
    try {
      const c = getAudioContext();
      if (!c) return;
      const notes = [659.25, 783.99, 987.77, 1318.51, 1567.98]; // E5, G5, B5, E6, G6
      notes.forEach((freq, idx) => {
        const osc = c.createOscillator();
        const gain = c.createGain();

        osc.type = "triangle";
        const startTime = c.currentTime + idx * 0.08;
        const dur = 0.22;

        osc.frequency.setValueAtTime(freq, startTime);
        gain.gain.setValueAtTime(0.2, startTime);
        gain.gain.exponentialRampToValueAtTime(0.001, startTime + dur);

        osc.connect(gain);
        gain.connect(c.destination);

        osc.start(startTime);
        osc.stop(startTime + dur);
      });
    } catch (_) {}
  }

  // Cadeado Bloquear / Desbloquear (click mecânico de trava)
  function playLock(isLocked) {
    if (isLocked) {
      playPop(880, 0.04, "square");
    } else {
      playPop(520, 0.045, "triangle");
    }
  }

  // Fechar Modal (som leve e abafado)
  function playClose() {
    playPop(420, 0.04, "sine");
  }

  return {
    pop: playPop,
    snap: playSnap,
    expand: playExpand,
    shrink: playShrink,
    grab: playGrab,
    drop: playDrop,
    complete: playComplete,
    uncomplete: playUncomplete,
    success: playSuccess,
    delete: playDelete,
    open: playOpen,
    close: playClose,
    alarm: playAlarm,
    lock: playLock
  };
})();

// Configuração do intervalo do dia
let dayConfig = JSON.parse(localStorage.getItem("planner_day_config_v2")) || {
  startTime: "08:00",
  endTime: "20:00"
};

let isSnapEnabled = JSON.parse(localStorage.getItem("planner_snap_enabled")) !== false; // Padrão: true

// Conversões e Arredondamento com Snap (5 em 5 minutos quando ativado)
function snapTo5Minutes(minutes) {
  if (!isSnapEnabled) return Math.round(minutes);
  return Math.round(minutes / 5) * 5;
}

function timeStringToMinutes(str) {
  if (!str) return 0;
  const parts = str.split(":").map(Number);
  return (parts[0] || 0) * 60 + (parts[1] || 0);
}

function minutesToTimeString(minutes) {
  const clamped = Math.max(0, Math.min(24 * 60, Math.round(minutes)));
  const h = Math.floor(clamped / 60);
  const m = Math.floor(clamped % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// Formatação precisa em horas e minutos (ex: 4h 42m, 2h 15m, 45m, 1h)
function formatMinutesExact(minutes) {
  const totalMins = Math.max(0, Math.round(minutes));
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

// Mantido como alias para compatibilidade com o formato exato
function formatHoursDecimal(hours) {
  return formatMinutesExact((hours || 0) * 60);
}

// Resolve colisões e aplica empurrão inteligente em cadeia
function applyCollisionPush(movingBlockId) {
  const cycleStartMin = timeStringToMinutes(dayConfig.startTime);
  const cycleEndMin = timeStringToMinutes(dayConfig.endTime);

  if (blocks.length <= 1) return;

  const targetBlock = blocks.find(b => b.id === movingBlockId);
  if (!targetBlock) return;

  // 1. Ordena os outros blocos pelo horário de início original
  const otherBlocks = blocks.filter(b => b.id !== movingBlockId);
  otherBlocks.sort((a, b) => timeStringToMinutes(a.startTime) - timeStringToMinutes(b.startTime));

  // Encontra onde o targetBlock se posiciona em relação aos outros
  const targetStart = timeStringToMinutes(targetBlock.startTime);
  const targetEnd = timeStringToMinutes(targetBlock.endTime);

  // Divide entre blocos que estavam à esquerda e à direita
  const leftBlocks = otherBlocks.filter(b => timeStringToMinutes(b.startTime) < targetStart);
  const rightBlocks = otherBlocks.filter(b => !leftBlocks.includes(b));

  // EMPURRÃO PARA A DIREITA (para todos os blocos afetados à direita)
  let currentBoundaryRight = targetEnd;
  for (let i = 0; i < rightBlocks.length; i++) {
    const b = rightBlocks[i];
    if (b.locked) {
      // Bloco travado não se move nem é empurrado
      currentBoundaryRight = timeStringToMinutes(b.endTime);
      continue;
    }
    let bStart = timeStringToMinutes(b.startTime);
    let bDur = Math.max(5, (b.duration || 60));

    if (bStart < currentBoundaryRight) {
      bStart = currentBoundaryRight;
      let bEnd = bStart + bDur;

      if (bEnd > cycleEndMin) {
        bEnd = cycleEndMin;
        bStart = Math.max(cycleStartMin, bEnd - bDur);
      }

      b.startTime = minutesToTimeString(bStart);
      b.endTime = minutesToTimeString(bEnd);
      b.duration = bEnd - bStart;
      b.actualMinutes = b.duration;
      currentBoundaryRight = bEnd;
    } else {
      currentBoundaryRight = timeStringToMinutes(b.endTime);
    }
  }

  // Se o empurrão à direita bateu no limite do dia ou num bloco travado, ajusta o targetBlock para não ultrapassar
  if (rightBlocks.length > 0) {
    const firstRight = rightBlocks[0];
    const firstRightStart = timeStringToMinutes(firstRight.startTime);
    if (timeStringToMinutes(targetBlock.endTime) > firstRightStart) {
      const targetDur = targetBlock.duration;
      const clampedEnd = firstRightStart;
      const clampedStart = Math.max(cycleStartMin, clampedEnd - targetDur);
      targetBlock.startTime = minutesToTimeString(clampedStart);
      targetBlock.endTime = minutesToTimeString(clampedEnd);
      targetBlock.duration = clampedEnd - clampedStart;
      targetBlock.actualMinutes = targetBlock.duration;
    }
  }

  // EMPURRÃO PARA A ESQUERDA (se expandiu para trás ou empurrou o anterior)
  let currentBoundaryLeft = timeStringToMinutes(targetBlock.startTime);
  for (let i = leftBlocks.length - 1; i >= 0; i--) {
    const b = leftBlocks[i];
    if (b.locked) {
      // Bloco travado não se move nem é empurrado
      currentBoundaryLeft = timeStringToMinutes(b.startTime);
      continue;
    }
    let bEnd = timeStringToMinutes(b.endTime);
    let bDur = Math.max(5, (b.duration || 60));

    if (bEnd > currentBoundaryLeft) {
      bEnd = currentBoundaryLeft;
      let bStart = bEnd - bDur;

      if (bStart < cycleStartMin) {
        bStart = cycleStartMin;
        bEnd = bStart + bDur;
      }

      b.startTime = minutesToTimeString(bStart);
      b.endTime = minutesToTimeString(bEnd);
      b.duration = bEnd - bStart;
      b.actualMinutes = b.duration;
      currentBoundaryLeft = bStart;
    } else {
      currentBoundaryLeft = timeStringToMinutes(b.startTime);
    }
  }

  // Se o empurrão à esquerda bateu no início do dia, ajusta o targetBlock
  if (leftBlocks.length > 0) {
    const lastLeft = leftBlocks[leftBlocks.length - 1];
    const lastLeftEnd = timeStringToMinutes(lastLeft.endTime);
    if (timeStringToMinutes(targetBlock.startTime) < lastLeftEnd) {
      const targetDur = targetBlock.duration;
      const clampedStart = lastLeftEnd;
      const clampedEnd = Math.min(cycleEndMin, clampedStart + targetDur);
      targetBlock.startTime = minutesToTimeString(clampedStart);
      targetBlock.endTime = minutesToTimeString(clampedEnd);
      targetBlock.duration = clampedEnd - clampedStart;
      targetBlock.actualMinutes = targetBlock.duration;
    }
  }

  // Sincroniza subtarefas de todos os blocos cujo tamanho possa ter mudado
  blocks.forEach(b => {
    const s = timeStringToMinutes(b.startTime);
    const e = timeStringToMinutes(b.endTime);
    b.actualMinutes = Math.max(5, e - s);
    b.duration = b.actualMinutes;

    if (b.subtasks && b.subtasks.length > 0) {
      b.subtasks.forEach(sub => {
        if (sub.percentage !== undefined && sub.percentage !== null) {
          sub.duration = Math.max(1, Math.round((sub.percentage / 100) * b.duration));
        }
      });
    }
  });

  // Reordena
  blocks.sort((a, b) => timeStringToMinutes(a.startTime) - timeStringToMinutes(b.startTime));
}

// CÁLCULO E VALIDAÇÃO DE HORÁRIOS NA LINHA DO TEMPO:
function recalculateTimelineSchedule() {
  const startDayMin = timeStringToMinutes(dayConfig.startTime);
  const endDayMin = timeStringToMinutes(dayConfig.endTime);
  const totalDayMin = Math.max(30, endDayMin - startDayMin);

  if (blocks.length === 0) return;

  blocks.sort((a, b) => timeStringToMinutes(a.startTime) - timeStringToMinutes(b.startTime));

  // Valida e aplica empurrão mútuo se necessário
  for (let i = 0; i < blocks.length - 1; i++) {
    const curEnd = timeStringToMinutes(blocks[i].endTime);
    const nextStart = timeStringToMinutes(blocks[i + 1].startTime);
    if (curEnd > nextStart) {
      applyCollisionPush(blocks[i].id);
      break;
    }
  }
}

function saveAll() {
  // Salva no LocalStorage isolado por data (garante persistência mesmo se WASM/SQLite falhar)
  try {
    localStorage.setItem(`planner_blocks_${selectedViewDate}`, JSON.stringify(blocks));
    localStorage.setItem(`planner_staged_${selectedViewDate}`, JSON.stringify(stagedBlocks));
    localStorage.setItem(`planner_day_config_${selectedViewDate}`, JSON.stringify(dayConfig));
    // Se for hoje, mantém compatibilidade com os campos padrão
    if (selectedViewDate === getTodayDateString()) {
      localStorage.setItem("planner_blocks_clean", JSON.stringify(blocks));
      localStorage.setItem("planner_staged_blocks_clean", JSON.stringify(stagedBlocks));
      localStorage.setItem("planner_day_config_v2", JSON.stringify(dayConfig));
    }
    localStorage.setItem("planner_task_library_v1", JSON.stringify(taskLibrary));
  } catch (e) {
    console.warn("Erro ao salvar no localStorage:", e);
  }

  persistToSQLite();
  renderAll();
}

// Sistema de Notificação e Verificação de Conclusão de Tarefa
let notifiedBlockEnds = JSON.parse(localStorage.getItem("planner_notified_ends") || "[]");
let promptActiveBlock = null;

function checkTaskCompletionAlarm(now) {
  // 1. Alarme só monitora tarefas do dia de hoje
  if (selectedViewDate !== getTodayDateString()) return;

  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  blocks.forEach(b => {
    const endM = timeStringToMinutes(b.endTime);

    // As notificações devem disparar ESTRITAMENTE no final do bloco (endTime), NUNCA no início (startTime).
    // Se o horário atual ainda não alcançou o fim do bloco, ignora
    if (currentMinutes < endM) {
      return;
    }

    // Dispara no minuto de término da tarefa (tolerância de até 1 minuto para garantir detecção)
    const diff = currentMinutes - endM;
    const notificationKey = `${b.id}_${b.endTime}_${now.toDateString()}`;

    if (diff >= 0 && diff <= 1 && !notifiedBlockEnds.includes(notificationKey)) {
      notifiedBlockEnds.push(notificationKey);
      localStorage.setItem("planner_notified_ends", JSON.stringify(notifiedBlockEnds));
      triggerTaskEndPrompt(b);
    }
  });
}

function triggerTaskEndPrompt(block) {
  promptActiveBlock = block;
  const modal = document.getElementById("taskCompletePromptModal");
  const modalTitle = document.getElementById("promptModalTitle");
  const taskName = document.getElementById("promptTaskName");
  const taskTime = document.getElementById("promptTaskTime");

  if (modalTitle) {
    modalTitle.textContent = "Fim da Tarefa!";
  }
  taskName.textContent = block.title;
  taskTime.textContent = `Término às ${block.endTime} (${block.startTime} — ${block.endTime})`;

  SoundFx.alarm();
  modal.classList.add("active");
  modal.setAttribute("aria-hidden", "false");

  // Dispara Notificação nativa do sistema/navegador se o usuário tiver concedido permissão
  if ("Notification" in window && Notification.permission === "granted") {
    try {
      new Notification(`Fim da Tarefa: ${block.title}`, {
        body: `O bloco agendado terminou às ${block.endTime}. Conseguiu concluir esta tarefa?`,
        icon: "manifest.json"
      });
    } catch (e) {
      console.warn("Web Notification falhou:", e);
    }
  }
}

function closeTaskEndPrompt() {
  const modal = document.getElementById("taskCompletePromptModal");
  if (modal) {
    modal.classList.remove("active");
    modal.setAttribute("aria-hidden", "true");
  }
  promptActiveBlock = null;
}

// Atualiza a linha do relógio ao vivo na timeline com indicador de hora em cima
function updateTimelineNowIndicator(now = new Date()) {
  const lineEl = document.getElementById("timelineNowIndicator");
  const badgeEl = document.getElementById("timelineNowBadge");
  const badgeText = document.getElementById("timelineNowBadgeText");
  if (!lineEl || !badgeEl || !badgeText) return;

  // Só exibe no dia de hoje
  if (selectedViewDate !== getTodayDateString()) {
    lineEl.style.display = "none";
    return;
  }

  const cycleStartMin = timeStringToMinutes(dayConfig.startTime);
  const cycleEndMin = timeStringToMinutes(dayConfig.endTime);
  const totalCycleMin = Math.max(30, cycleEndMin - cycleStartMin);

  const currentDayMinutes = now.getHours() * 60 + now.getMinutes() + (now.getSeconds() / 60);

  // Se o horário estiver fora dos limites do ciclo do dia, oculta a linha
  if (currentDayMinutes < cycleStartMin || currentDayMinutes > cycleEndMin) {
    lineEl.style.display = "none";
    return;
  }

  const pct = Math.max(0, Math.min(100, ((currentDayMinutes - cycleStartMin) / totalCycleMin) * 100));
  lineEl.style.display = "block";
  lineEl.style.left = `${pct.toFixed(3)}%`;

  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  // Atualiza em tempo real a cada segundo com precisão de segundos (HH:MM:SS)
  badgeText.textContent = `${hh}:${mm}:${ss}`;

  // Ajusta alinhamento do badge nas extremidades para não vazar a borda
  if (pct < 5) {
    badgeEl.classList.add("edge-start");
    badgeEl.classList.remove("edge-end");
    badgeEl.style.left = "";
    badgeEl.style.right = "";
    badgeEl.style.transform = "";
  } else if (pct > 95) {
    badgeEl.classList.add("edge-end");
    badgeEl.classList.remove("edge-start");
    badgeEl.style.left = "";
    badgeEl.style.right = "";
    badgeEl.style.transform = "";
  } else {
    badgeEl.classList.remove("edge-start", "edge-end");
    badgeEl.style.left = "";
    badgeEl.style.right = "";
    badgeEl.style.transform = "";
  }
}

// Atualiza o preenchimento das barras de progresso na timeline a cada segundo
function updateTimelineProgressBars(now) {
  const isToday = (selectedViewDate === getTodayDateString());
  const currentDayMinutes = now.getHours() * 60 + now.getMinutes() + (now.getSeconds() / 60);

  document.querySelectorAll(".timeline-block").forEach(blockEl => {
    const bId = blockEl.dataset.id;
    const block = blocks.find(b => b.id === bId);
    if (!block) return;

    const startM = timeStringToMinutes(block.startTime);
    const endM = timeStringToMinutes(block.endTime);
    const durM = Math.max(1, endM - startM);

    let fillPct = 0;
    const isCurrentActive = isToday && (currentDayMinutes >= startM && currentDayMinutes < endM);

    if (isToday && currentDayMinutes > startM) {
      if (currentDayMinutes >= endM) {
        fillPct = 100;
      } else {
        fillPct = ((currentDayMinutes - startM) / durM) * 100;
      }
    }

    blockEl.classList.toggle("is-active-running", isCurrentActive);

    const fillEl = blockEl.querySelector(".timeline-block-progress-fill");
    if (fillEl) {
      fillEl.style.width = `${fillPct.toFixed(1)}%`;
    }
  });
}

// Relógio ao Vivo com Data e Hora
function startLiveClock() {
  const timeEl = document.getElementById("liveClockTime");
  const dateEl = document.getElementById("liveClockDate");
  if (!timeEl || !dateEl) return;

  function update() {
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, "0");
    const minutes = String(now.getMinutes()).padStart(2, "0");
    const seconds = String(now.getSeconds()).padStart(2, "0");
    timeEl.textContent = `${hours}:${minutes}:${seconds}`;

    // Ex: QUA, 28 OUT 2026
    const days = ["DOM", "SEG", "TER", "QUA", "QUI", "SEX", "SÁB"];
    const months = ["JAN", "FEV", "MAR", "ABR", "MAI", "JUN", "JUL", "AGO", "SET", "OUT", "NOV", "DEZ"];
    const dayWeek = days[now.getDay()];
    const dayMonth = String(now.getDate()).padStart(2, "0");
    const month = months[now.getMonth()];
    const year = now.getFullYear();

    dateEl.textContent = `${dayWeek} // ${dayMonth} ${month} ${year}`;

    // Atualiza o preenchimento temporal dos blocos da timeline
    updateTimelineProgressBars(now);

    // Atualiza a linha do relógio ao vivo na timeline com indicador de hora no topo
    updateTimelineNowIndicator(now);

    // Checa alarme de término de tarefa
    checkTaskCompletionAlarm(now);
  }

  update();
  setInterval(update, 1000);
}

// Inicializar Aplicação
async function init() {
  startLiveClock();
  syncDayInputs();
  syncSnapUI();
  renderHoursHeader();
  renderAll();
  setupEvents();
  setupDragAndDrop();
  setupResizeHandles();
  setupIconPicker();
  setupColorSwatches();
  registerPWA();
  await initSQLite();
}

function syncSnapUI() {
  const btn = document.getElementById("snapToggleBtn");
  if (btn) {
    btn.classList.toggle("active", isSnapEnabled);
    btn.title = isSnapEnabled ? "Encaixe Magnético (5m): Ativado (Clique para desligar)" : "Encaixe Magnético: Desativado (Clique para ativar)";
    refreshLucideIcons();
  }
}

function syncDayInputs() {
  const rangeDisplay = document.getElementById("cycleRangeDisplay");
  const totalIndicator = document.getElementById("cycleTotalIndicator");

  if (rangeDisplay) {
    rangeDisplay.textContent = `${dayConfig.startTime} — ${dayConfig.endTime}`;
  }

  const totalCycleHours = (timeStringToMinutes(dayConfig.endTime) - timeStringToMinutes(dayConfig.startTime)) / 60;
  if (totalIndicator) {
    totalIndicator.textContent = formatHoursDecimal(totalCycleHours);
  }
}

function renderLegend() {
  const container = document.getElementById("legendList");
  container.innerHTML = Object.entries(CATEGORIES).map(([catKey, cat]) => {
    return `
      <div class="legend-item">
        <span class="icon">${cat.icon}</span>
        <span>${cat.name}</span>
      </div>
    `;
  }).join("");
}

function renderHoursHeader() {
  const hoursContainer = document.getElementById("timelineHours");
  if (!hoursContainer) return;
  hoursContainer.innerHTML = "";

  const cycleStartMin = timeStringToMinutes(dayConfig.startTime);
  const cycleEndMin = timeStringToMinutes(dayConfig.endTime);
  const totalCycleMin = Math.max(30, cycleEndMin - cycleStartMin);

  // Renderiza cada hora cheia que existe no ciclo do dia
  const startHour = Math.floor(cycleStartMin / 60);
  const endHour = Math.ceil(cycleEndMin / 60);

  for (let h = startHour; h <= endHour; h++) {
    const minutePoint = h * 60;
    if (minutePoint >= cycleStartMin && minutePoint <= cycleEndMin) {
      const pct = ((minutePoint - cycleStartMin) / totalCycleMin) * 100;
      const span = document.createElement("span");
      span.className = "timeline-hour-mark";
      span.style.left = `${pct}%`;

      // Se for exatamente na borda esquerda (0%), alinha à esquerda para não cortar
      // Se for na borda direita (100%), alinha à direita
      if (pct === 0) {
        span.style.transform = "translateX(0%)";
      } else if (pct === 100) {
        span.style.transform = "translateX(-100%)";
      } else {
        span.style.transform = "translateX(-50%)";
      }

      span.textContent = `${String(h).padStart(2, "0")}:00`;
      hoursContainer.appendChild(span);
    }
  }
}

function renderRulerTicks() {
  const ruler = document.getElementById("timelineRuler");
  if (!ruler) return;
  ruler.innerHTML = "";

  const startMin = timeStringToMinutes(dayConfig.startTime);
  const endMin = timeStringToMinutes(dayConfig.endTime);
  const totalMin = Math.max(30, endMin - startMin);

  // Gera marcações de régua de 5 em 5 minutos
  for (let m = startMin; m <= endMin; m += 5) {
    const tick = document.createElement("div");
    const pct = ((m - startMin) / totalMin) * 100;
    tick.style.left = `${pct}%`;

    const minInHour = m % 60;
    if (minInHour === 0) {
      tick.className = "ruler-tick tick-60";
    } else if (minInHour === 30) {
      tick.className = "ruler-tick tick-30";
    } else if (minInHour === 15 || minInHour === 45) {
      tick.className = "ruler-tick tick-15";
    } else {
      tick.className = "ruler-tick";
    }

    ruler.appendChild(tick);
  }
}

function renderAll() {
  recalculateTimelineSchedule();
  renderRulerTicks();
  renderTimeline();
  updateTimelineNowIndicator();
  renderMetrics();
  renderStagedList();
  renderBlocksList();
}

// Renderiza a Timeline Contínua
function renderTimeline() {
  const track = document.getElementById("timelineTrack");
  const durationsContainer = document.getElementById("timelineDurations");
  track.innerHTML = "";
  durationsContainer.innerHTML = "";

  // Se não houver nenhum bloco agendado na timeline, mostra indicador visual clicável
  if (blocks.length === 0) {
    const emptyPrompt = document.createElement("div");
    emptyPrompt.className = "timeline-empty-prompt";
    emptyPrompt.title = "Clique para adicionar uma tarefa ao cronograma";
    emptyPrompt.innerHTML = `
      <div class="timeline-empty-content">
        <div class="timeline-empty-icon">+</div>
        <div class="timeline-empty-text">
          <strong>Nenhuma tarefa agendada neste ciclo</strong>
          <span>Clique aqui para selecionar uma tarefa existente ou criar uma nova</span>
        </div>
      </div>
    `;
    emptyPrompt.addEventListener("click", () => {
      openSelectTaskModal();
    });
    track.appendChild(emptyPrompt);
    return;
  }

  const cycleStartMinutes = timeStringToMinutes(dayConfig.startTime);
  const cycleEndMinutes = timeStringToMinutes(dayConfig.endTime);
  const totalCycleMinutes = Math.max(30, cycleEndMinutes - cycleStartMinutes);

  blocks.forEach((block, index) => {
    const startM = timeStringToMinutes(block.startTime);
    const endM = timeStringToMinutes(block.endTime);
    const durationM = Math.max(0, endM - startM);
    const durationHours = durationM / 60;

    const leftPercent = Math.max(0, Math.min(100, ((startM - cycleStartMinutes) / totalCycleMinutes) * 100));
    const widthPercent = Math.max(0, Math.min(100 - leftPercent, (durationM / totalCycleMinutes) * 100));

    const blockEl = document.createElement("div");
    blockEl.className = `timeline-block ${block.locked ? 'is-locked' : ''}`;
    blockEl.dataset.index = index;
    blockEl.dataset.id = block.id;
    blockEl.style.left = `${leftPercent}%`;
    blockEl.style.width = `${Math.max(widthPercent, 1.2)}%`;
    blockEl.style.backgroundColor = block.color;
    blockEl.title = `${block.title} (${block.startTime} - ${block.endTime})${block.locked ? ' [BLOQUEADO / TRAVADO]' : ' - Arraste para mover ou redimensione pelas pontas'}`;

    const iconContent = block.icon ? `<span class="block-inner-icon">${renderAppIcon(block.icon)}</span>` : `<span class="block-inner-text">${block.title}</span>`;
    
    // Botão de Cadeado Próprio do Bloco
    const lockIconName = block.locked ? "lock" : "unlock";
    const lockBtnTitle = block.locked ? "Bloco travado: clique para destravar e permitir mover" : "Clique para travar este bloco contra movimentações";
    const lockBtnHtml = `
      <button type="button" class="block-lock-btn ${block.locked ? 'locked' : ''}" data-id="${block.id}" title="${lockBtnTitle}">
        <i data-lucide="${lockIconName}" class="app-icon"></i>
      </button>
    `;
    
    // Calcula o preenchimento da barra com o passar do tempo do dia
    const now = new Date();
    const currentDayMinutes = now.getHours() * 60 + now.getMinutes() + (now.getSeconds() / 60);
    let fillPct = 0;
    if (currentDayMinutes > startM) {
      if (currentDayMinutes >= endM) {
        fillPct = 100;
      } else if (durationM > 0) {
        fillPct = ((currentDayMinutes - startM) / durationM) * 100;
      }
    }

    // Carrossel/Cards deslizantes das subtarefas dentro do bloco
    let subtasksHtml = "";
    if (block.subtasks && block.subtasks.length > 0) {
      const pills = block.subtasks.map(s => {
        return `
          <div class="timeline-subtask-pill ${s.completed ? 'completed' : ''}" title="${s.text}">
            <span class="subtask-pill-dot"></span>
            <span>${s.text}</span>
          </div>
        `;
      }).join("");
      subtasksHtml = `<div class="timeline-subtasks-carousel">${pills}</div>`;
    }

    blockEl.innerHTML = `
      ${!block.locked ? '<div class="resize-handle resize-handle-left" title="Arrastar para diminuir/aumentar o tempo"></div>' : ''}
      <div class="timeline-block-progress-fill" style="width: ${fillPct.toFixed(1)}%;"></div>
      ${lockBtnHtml}
      <div class="block-inner-content">
        ${iconContent}
        ${subtasksHtml}
      </div>
      ${!block.locked ? '<div class="resize-handle resize-handle-right" title="Arrastar para diminuir/aumentar o tempo"></div>' : ''}
    `;

    // Evento do botão de Cadeado
    blockEl.querySelector(".block-lock-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      block.locked = !block.locked;
      SoundFx.lock(block.locked);
      saveAll();
    });

    // Evento de clique para abrir modal de subtarefas apenas se não arrastou nem redimensionou
    blockEl.addEventListener("click", (e) => {
      if (isDraggingBlock || isResizing || hasMovedWhileDragging) return;
      if (e.target.closest(".block-lock-btn") || e.target.classList.contains("resize-handle")) return;
      SoundFx.open();
      openSubtasksModal(block.id, "timeline");
    });

    track.appendChild(blockEl);
  });

  refreshLucideIcons();
  updateTimelineProgressBars(new Date());
}

// Renderiza Métricas baseadas no tempo real das tarefas e intervalos
function renderMetrics() {
  const cycleStartMin = timeStringToMinutes(dayConfig.startTime);
  const cycleEndMin = timeStringToMinutes(dayConfig.endTime);
  const totalCycleMin = Math.max(0, cycleEndMin - cycleStartMin);

  let plannedMinutes = 0;

  // Ordena os blocos para calcular os intervalos livres com precisão
  const sortedBlocks = [...blocks].sort((a, b) => timeStringToMinutes(a.startTime) - timeStringToMinutes(b.startTime));

  sortedBlocks.forEach(b => {
    const s = timeStringToMinutes(b.startTime);
    const e = timeStringToMinutes(b.endTime);
    const dur = Math.max(0, e - s);
    plannedMinutes += dur;
  });

  // O tempo de descanso/intervalo é a soma de todos os espaços onde NÃO há bloco agendado no ciclo
  const restMinutes = Math.max(0, totalCycleMin - plannedMinutes);

  const grid = document.getElementById("metricsGrid");
  grid.innerHTML = `
    <div class="metric-card">
      <span class="metric-title">Tempo em Tarefas</span>
      <span class="metric-val">${formatMinutesExact(plannedMinutes)}</span>
    </div>
    <div class="metric-card">
      <span class="metric-title">Descanso // Intervalos</span>
      <span class="metric-val">${formatMinutesExact(restMinutes)}</span>
    </div>
    <div class="metric-card">
      <span class="metric-title">Ciclo Total</span>
      <span class="metric-val">${formatMinutesExact(totalCycleMin)}</span>
    </div>
  `;
}

// Renderiza Bloco em Espera / Banco de Tarefas Não Agendadas
function renderStagedList() {
  const container = document.getElementById("stagedList");
  const emptyMsg = document.getElementById("stagedEmptyMsg");
  const countPill = document.getElementById("stagedCountPill");

  countPill.textContent = stagedBlocks.length;
  container.innerHTML = "";

  if (stagedBlocks.length === 0) {
    emptyMsg.style.display = "block";
    return;
  }
  emptyMsg.style.display = "none";

  stagedBlocks.forEach((item, index) => {
    const subCount = item.subtasks ? item.subtasks.length : 0;
    const durHours = (item.duration || 60) / 60;
    const iconSpan = item.icon ? `<span class="staged-chip-icon">${renderAppIcon(item.icon)}</span>` : '';

    const chip = document.createElement("div");
    chip.className = "staged-chip";
    chip.draggable = true;
    chip.dataset.id = item.id;
    chip.dataset.index = index;

    chip.innerHTML = `
      <div class="staged-chip-stripe" style="background-color: ${item.color};"></div>
      ${iconSpan}
      <div class="staged-chip-content">
        <span class="staged-chip-title">${item.title}</span>
        <span class="staged-chip-meta">${formatHoursDecimal(durHours)} • ${subCount} subtarefas</span>
      </div>
      <div class="staged-chip-actions">
        <button class="btn-chip-action move-up-btn" title="Adicionar à Linha do Tempo">↑ Agendar</button>
      </div>
    `;

    chip.querySelector(".move-up-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      SoundFx.success();
      moveStagedToTimeline(item.id);
    });

    chip.addEventListener("click", () => {
      SoundFx.open();
      openSubtasksModal(item.id, "staged");
    });

    container.appendChild(chip);
  });

  refreshLucideIcons();
}

// Move bloco em espera para a Linha do Tempo
function moveStagedToTimeline(stagedId, targetIndex = null, preferredStartMinutes = null) {
  const idx = stagedBlocks.findIndex(b => b.id === stagedId);
  if (idx === -1) return;
  const [item] = stagedBlocks.splice(idx, 1);

  const cycleStartMinutes = timeStringToMinutes(dayConfig.startTime);
  const cycleEndMinutes = timeStringToMinutes(dayConfig.endTime);
  const totalDayMinutes = Math.max(30, cycleEndMinutes - cycleStartMinutes);

  // Duração preservada fielmente (ex: 4 horas), arredondada para o múltiplo de 5m mais próximo
  const rawDuration = item.duration || 60;
  const duration = Math.max(5, Math.min(totalDayMinutes, snapTo5Minutes(rawDuration)));
  item.duration = duration;
  item.actualMinutes = duration;

  // Calcula a porcentagem das subtarefas com base na duração de criação caso ainda não tenham
  if (item.subtasks && item.subtasks.length > 0) {
    item.subtasks.forEach(s => {
      if (s.duration && (!s.percentage || s.percentage <= 0)) {
        s.percentage = (s.duration / duration) * 100;
      }
    });
  }

  // Define horário de início respeitando o ciclo do dia com snap de 5 em 5 minutos
  let startMin;
  if (preferredStartMinutes !== null) {
    const snappedPreferred = snapTo5Minutes(preferredStartMinutes);
    startMin = Math.max(cycleStartMinutes, Math.min(cycleEndMinutes - duration, snappedPreferred));
  } else {
    // Se não especificado (ex: clicou em "+ Agendar"), tenta colocar no final dos blocos existentes ou início do dia
    if (blocks.length > 0) {
      const lastBlock = blocks[blocks.length - 1];
      startMin = snapTo5Minutes(timeStringToMinutes(lastBlock.endTime));
      if (startMin + duration > cycleEndMinutes) {
        startMin = Math.max(cycleStartMinutes, cycleEndMinutes - duration);
      }
    } else {
      startMin = cycleStartMinutes;
    }
  }

  item.startTime = minutesToTimeString(startMin);
  item.endTime = minutesToTimeString(startMin + duration);

  if (targetIndex !== null && targetIndex >= 0 && targetIndex <= blocks.length) {
    blocks.splice(targetIndex, 0, item);
  } else {
    blocks.push(item);
  }
  saveAll();
}

// Move bloco da Linha do Tempo para Espera
function moveTimelineToStaged(blockId) {
  const idx = blocks.findIndex(b => b.id === blockId);
  if (idx === -1) return;
  const [item] = blocks.splice(idx, 1);
  stagedBlocks.push(item);
  saveAll();
}

// Renderiza Lista de Blocos Agendados (se a seção estiver presente no DOM)
function renderBlocksList() {
  const list = document.getElementById("blocksList");
  const countPill = document.getElementById("timelineCountPill");
  if (!list) return;

  if (countPill) countPill.textContent = blocks.length;
  list.innerHTML = "";

  blocks.forEach((block, index) => {
    const card = document.createElement("div");
    card.className = "block-card";
    card.draggable = true;
    card.dataset.id = block.id;
    card.dataset.index = index;

    const totalSub = block.subtasks ? block.subtasks.length : 0;
    const completedSub = block.subtasks ? block.subtasks.filter(s => s.completed).length : 0;
    const iconSpan = block.icon ? `<span class="block-card-icon">${renderAppIcon(block.icon)}</span>` : '';

    card.innerHTML = `
      <div class="block-card-stripe" style="background-color: ${block.color};"></div>
      <div class="block-card-header">
        ${iconSpan}
        <div class="block-card-title-wrap">
          <div class="block-card-title">${block.title}</div>
          <div class="block-card-time">${block.startTime} - ${block.endTime} (${formatHoursDecimal((block.actualMinutes || 60) / 60)})</div>
        </div>
      </div>
      <div class="block-card-stats">
        <span>${totalSub} subtarefas</span>
        <span class="subtasks-preview-pill">${completedSub}/${totalSub} feitas</span>
      </div>
    `;

    card.addEventListener("click", () => openSubtasksModal(block.id, "timeline"));
    list.appendChild(card);
  });
}

// DRAG AND DROP (Mover bloco da Espera para Timeline ou Reordenar na Lista)
let draggedType = null; // 'staged' ou 'blocksList'
let draggedId = null;

// ARRASTAR BLOCO DENTRO DA LINHA DO TEMPO (Pointer Drag com Snap em tempo real)
let isDraggingBlock = false;
let draggingBlockId = null;
let dragStartX = 0;
let dragStartY = 0;
let dragOriginalStartMin = 0;
let dragBlockDuration = 0;
let hasMovedWhileDragging = false;

function setupDragAndDrop() {
  const track = document.getElementById("timelineTrack");
  const stagedDropArea = document.getElementById("stagedDropArea");
  const blocksList = document.getElementById("blocksList");

  // Arrasto por HTML5 Drag apenas para chips da espera e cards da lista
  document.addEventListener("dragstart", (e) => {
    const target = e.target.closest("[draggable='true']");
    if (!target) return;

    draggedId = target.dataset.id;
    if (target.classList.contains("staged-chip")) {
      draggedType = "staged";
    } else {
      draggedType = "blocksList";
    }

    target.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", draggedId);
  });

  document.addEventListener("dragend", () => {
    document.querySelectorAll(".dragging, .drag-over, .drag-target").forEach(el => {
      el.classList.remove("dragging", "drag-over", "drag-target");
    });
    draggedType = null;
    draggedId = null;
  });

  // Eventos na Linha do Tempo para soltar bloco da espera
  track.addEventListener("dragover", (e) => {
    e.preventDefault();
    track.classList.add("drag-over");
    const targetBlock = e.target.closest(".timeline-block");
    document.querySelectorAll(".timeline-block.drag-target").forEach(b => b.classList.remove("drag-target"));
    if (targetBlock && targetBlock.dataset.id !== draggedId) {
      targetBlock.classList.add("drag-target");
    }
  });

  track.addEventListener("dragleave", (e) => {
    if (e.target === track) track.classList.remove("drag-over");
  });

  track.addEventListener("drop", (e) => {
    e.preventDefault();
    track.classList.remove("drag-over");
    const targetBlock = e.target.closest(".timeline-block");
    let targetIndex = blocks.length;

    if (targetBlock) {
      targetIndex = parseInt(targetBlock.dataset.index, 10);
    }

    const trackRect = track.getBoundingClientRect();
    const dropX = e.clientX - trackRect.left;
    const dropRatio = Math.max(0, Math.min(1, dropX / trackRect.width));
    const cycleStartMin = timeStringToMinutes(dayConfig.startTime);
    const cycleEndMin = timeStringToMinutes(dayConfig.endTime);
    const totalDayMin = Math.max(30, cycleEndMin - cycleStartMin);
    const rawStartMinutes = cycleStartMin + dropRatio * totalDayMin;
    const preferredStartMinutes = snapTo5Minutes(rawStartMinutes);

    if (draggedType === "staged") {
      moveStagedToTimeline(draggedId, targetIndex, preferredStartMinutes);
    }
  });

  // Eventos nos Cards de Blocos (se presentes)
  if (blocksList) {
    blocksList.addEventListener("dragover", (e) => {
      e.preventDefault();
      const targetCard = e.target.closest(".block-card");
      document.querySelectorAll(".block-card.drag-target").forEach(c => c.classList.remove("drag-target"));
      if (targetCard && targetCard.dataset.id !== draggedId) {
        targetCard.classList.add("drag-target");
      }
    });

    blocksList.addEventListener("drop", (e) => {
      e.preventDefault();
      const targetCard = e.target.closest(".block-card");
      if (!targetCard) return;
      const targetIndex = parseInt(targetCard.dataset.index, 10);

      if (draggedType === "staged") {
        moveStagedToTimeline(draggedId, targetIndex);
      } else if (draggedType === "blocksList") {
        const oldIndex = blocks.findIndex(b => b.id === draggedId);
        if (oldIndex !== -1 && oldIndex !== targetIndex) {
          const [moved] = blocks.splice(oldIndex, 1);
          blocks.splice(targetIndex, 0, moved);
          saveAll();
        }
      }
    });
  }

  // Eventos na Área de Espera (Permite arrastar bloco da lista de volta para espera!)
  stagedDropArea.addEventListener("dragover", (e) => {
    e.preventDefault();
    stagedDropArea.classList.add("drag-over");
  });

  stagedDropArea.addEventListener("dragleave", (e) => {
    if (e.target === stagedDropArea) stagedDropArea.classList.remove("drag-over");
  });

  stagedDropArea.addEventListener("drop", (e) => {
    e.preventDefault();
    stagedDropArea.classList.remove("drag-over");
    if (draggedType === "blocksList") {
      moveTimelineToStaged(draggedId);
    }
  });

  // ARRASTO SUAVE E PRECISO DENTRO DA LINHA DO TEMPO (Sem sair do container, com snap em tempo real)
  track.addEventListener("mousedown", (e) => {
    if (e.target.closest(".resize-handle") || e.target.closest(".block-lock-btn")) return;
    const blockEl = e.target.closest(".timeline-block");
    if (!blockEl) return;

    const block = blocks.find(b => b.id === blockEl.dataset.id);
    if (block && block.locked) {
      SoundFx.pop(300, 0.04);
      return; // Bloco travado por cadeado não se move
    }

    isDraggingBlock = true;
    draggingBlockId = blockEl.dataset.id;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    hasMovedWhileDragging = false;
    SoundFx.grab();

    if (block) {
      dragOriginalStartMin = timeStringToMinutes(block.startTime);
      dragBlockDuration = block.duration || (timeStringToMinutes(block.endTime) - dragOriginalStartMin);
    }

    blockEl.classList.add("in-drag-move");
  });

  document.addEventListener("mousemove", (e) => {
    if (!isDraggingBlock || !draggingBlockId || isResizing) return;

    const deltaPixelsX = e.clientX - dragStartX;
    const deltaPixelsY = e.clientY - dragStartY;

    if (Math.abs(deltaPixelsX) > 3 || Math.abs(deltaPixelsY) > 3) {
      hasMovedWhileDragging = true;
    }

    const trackRect = track.getBoundingClientRect();
    const trackWidth = trackRect.width;
    if (trackWidth <= 0) return;

    // MARGEM DE CONFORTO: só descola verticalmente se puxar mais de 45px para fora
    const Y_MARGIN_THRESHOLD = 45;
    const isDetached = Math.abs(deltaPixelsY) > Y_MARGIN_THRESHOLD;

    const blockEl = track.querySelector(`.timeline-block[data-id="${draggingBlockId}"]`);
    if (blockEl) {
      blockEl.classList.toggle("in-drag-detached", isDetached);
      if (isDetached) {
        // Bloco descolado: acompanha o cursor para ser carregado ou solto na espera
        blockEl.style.transform = `translate(0px, ${deltaPixelsY}px) scale(1.03)`;
      } else {
        // Dentro da margem de conforto: desliza suavemente sobre a timeline
        blockEl.style.transform = "translateY(-4px)";
      }
    }

    const isOverStaged = stagedDropArea && (
      e.clientX >= stagedDropArea.getBoundingClientRect().left &&
      e.clientX <= stagedDropArea.getBoundingClientRect().right &&
      e.clientY >= stagedDropArea.getBoundingClientRect().top &&
      e.clientY <= stagedDropArea.getBoundingClientRect().bottom
    );

    if (stagedDropArea) {
      stagedDropArea.classList.toggle("drag-pull-down", isOverStaged);
    }

    // Só atualiza os horários da timeline se não tiver sido puxado muito longe para baixo
    if (deltaPixelsY < Y_MARGIN_THRESHOLD * 1.5) {
      const cycleStartMin = timeStringToMinutes(dayConfig.startTime);
      const cycleEndMin = timeStringToMinutes(dayConfig.endTime);
      const totalDayMin = Math.max(30, cycleEndMin - cycleStartMin);

      const deltaMinutes = (deltaPixelsX / trackWidth) * totalDayMin;
      const rawTargetStart = dragOriginalStartMin + deltaMinutes;
      const snappedStart = snapTo5Minutes(rawTargetStart);

      // Confinamento obrigatório: não permite sair do ciclo do dia
      const clampedStart = Math.max(cycleStartMin, Math.min(cycleEndMin - dragBlockDuration, snappedStart));

      const block = blocks.find(b => b.id === draggingBlockId);
      if (block) {
        const oldStart = timeStringToMinutes(block.startTime);
        if (oldStart !== clampedStart) {
          SoundFx.snap();
        }
        block.startTime = minutesToTimeString(clampedStart);
        block.endTime = minutesToTimeString(clampedStart + dragBlockDuration);
        block.actualMinutes = dragBlockDuration;
        block.duration = dragBlockDuration;

        // Aplica empurrão magnético aos blocos adjacentes
        applyCollisionPush(draggingBlockId);

        // Atualiza visualização suave na timeline em tempo real
        renderTimeline();
        renderMetrics();
      }
    }
  });

  document.addEventListener("mouseup", (e) => {
    if (stagedDropArea) {
      stagedDropArea.classList.remove("drag-pull-down");
    }

    if (isDraggingBlock) {
      if (draggingBlockId) {
        // Se o soltar ocorreu sobre a área de espera
        let droppedOnStaged = false;
        if (stagedDropArea) {
          const rect = stagedDropArea.getBoundingClientRect();
          if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
            droppedOnStaged = true;
          }
        }

        if (droppedOnStaged) {
          SoundFx.pop(480, 0.05);
          moveTimelineToStaged(draggingBlockId);
          isDraggingBlock = false;
          draggingBlockId = null;
          document.querySelectorAll(".timeline-block.in-drag-move").forEach(el => el.classList.remove("in-drag-move"));
          return;
        }

        applyCollisionPush(draggingBlockId);
      }
      isDraggingBlock = false;
      draggingBlockId = null;
      document.querySelectorAll(".timeline-block.in-drag-move").forEach(el => {
        el.classList.remove("in-drag-move");
        el.style.transform = "";
      });
      if (hasMovedWhileDragging) {
        SoundFx.drop();
        saveAll();
      }
    }
  });

  // Suporte a Touch para arrastar na timeline no celular / Android
  track.addEventListener("touchstart", (e) => {
    if (e.target.closest(".resize-handle") || e.target.closest(".block-lock-btn")) return;
    const blockEl = e.target.closest(".timeline-block");
    if (!blockEl) return;

    const block = blocks.find(b => b.id === blockEl.dataset.id);
    if (block && block.locked) {
      SoundFx.pop(300, 0.04);
      return; // Bloco travado por cadeado
    }

    const touch = e.touches[0];
    isDraggingBlock = true;
    draggingBlockId = blockEl.dataset.id;
    dragStartX = touch.clientX;
    dragStartY = touch.clientY;
    hasMovedWhileDragging = false;
    SoundFx.grab();

    if (block) {
      dragOriginalStartMin = timeStringToMinutes(block.startTime);
      dragBlockDuration = block.duration || (timeStringToMinutes(block.endTime) - dragOriginalStartMin);
    }
    blockEl.classList.add("in-drag-move");
  }, { passive: false });

  document.addEventListener("touchmove", (e) => {
    if (!isDraggingBlock || !draggingBlockId || isResizing) return;

    const touch = e.touches[0];
    const deltaPixelsX = touch.clientX - dragStartX;
    const deltaPixelsY = touch.clientY - dragStartY;

    if (Math.abs(deltaPixelsX) > 3 || Math.abs(deltaPixelsY) > 3) {
      hasMovedWhileDragging = true;
    }

    const trackRect = track.getBoundingClientRect();
    const trackWidth = trackRect.width;
    if (trackWidth <= 0) return;

    // MARGEM DE CONFORTO NO TOUCH: 45px
    const Y_MARGIN_THRESHOLD = 45;
    const isDetached = Math.abs(deltaPixelsY) > Y_MARGIN_THRESHOLD;

    const blockEl = track.querySelector(`.timeline-block[data-id="${draggingBlockId}"]`);
    if (blockEl) {
      blockEl.classList.toggle("in-drag-detached", isDetached);
      if (isDetached) {
        blockEl.style.transform = `translate(0px, ${deltaPixelsY}px) scale(1.03)`;
      } else {
        blockEl.style.transform = "translateY(-4px)";
      }
    }

    const isOverStaged = stagedDropArea && (
      touch.clientX >= stagedDropArea.getBoundingClientRect().left &&
      touch.clientX <= stagedDropArea.getBoundingClientRect().right &&
      touch.clientY >= stagedDropArea.getBoundingClientRect().top &&
      touch.clientY <= stagedDropArea.getBoundingClientRect().bottom
    );

    if (stagedDropArea) {
      stagedDropArea.classList.toggle("drag-pull-down", isOverStaged);
    }

    if (deltaPixelsY < Y_MARGIN_THRESHOLD * 1.5) {
      const cycleStartMin = timeStringToMinutes(dayConfig.startTime);
      const cycleEndMin = timeStringToMinutes(dayConfig.endTime);
      const totalDayMin = Math.max(30, cycleEndMin - cycleStartMin);

      const deltaMinutes = (deltaPixelsX / trackWidth) * totalDayMin;
      const rawTargetStart = dragOriginalStartMin + deltaMinutes;
      const snappedStart = snapTo5Minutes(rawTargetStart);
      const clampedStart = Math.max(cycleStartMin, Math.min(cycleEndMin - dragBlockDuration, snappedStart));

      const block = blocks.find(b => b.id === draggingBlockId);
      if (block) {
        const oldStart = timeStringToMinutes(block.startTime);
        if (oldStart !== clampedStart) {
          SoundFx.snap();
        }
        block.startTime = minutesToTimeString(clampedStart);
        block.endTime = minutesToTimeString(clampedStart + dragBlockDuration);
        block.actualMinutes = dragBlockDuration;
        block.duration = dragBlockDuration;

        applyCollisionPush(draggingBlockId);

        renderTimeline();
        renderMetrics();
      }
    }
  }, { passive: false });

  document.addEventListener("touchend", (e) => {
    if (stagedDropArea) {
      stagedDropArea.classList.remove("drag-pull-down");
    }

    if (isDraggingBlock) {
      if (draggingBlockId) {
        const touch = e.changedTouches ? e.changedTouches[0] : null;
        if (touch) {
          let droppedOnStaged = false;
          if (stagedDropArea) {
            const rect = stagedDropArea.getBoundingClientRect();
            if (
              touch.clientX >= rect.left &&
              touch.clientX <= rect.right &&
              touch.clientY >= rect.top &&
              touch.clientY <= rect.bottom
            ) {
              droppedOnStaged = true;
            }
          }

          if (droppedOnStaged) {
            SoundFx.pop(480, 0.05);
            moveTimelineToStaged(draggingBlockId);
            isDraggingBlock = false;
            draggingBlockId = null;
            document.querySelectorAll(".timeline-block.in-drag-move").forEach(el => el.classList.remove("in-drag-move"));
            return;
          }
        }
        applyCollisionPush(draggingBlockId);
      }
      isDraggingBlock = false;
      draggingBlockId = null;
      document.querySelectorAll(".timeline-block.in-drag-move").forEach(el => {
        el.classList.remove("in-drag-move");
        el.style.transform = "";
      });
      if (hasMovedWhileDragging) {
        SoundFx.drop();
        saveAll();
      }
    }
  });
}

// Redimensiona dinamicamente diminuindo o bloco vizinho ao invés de sobrepor
function applyDynamicShrinkResize(resizingId, direction, desiredMinutes) {
  const cycleStartMin = timeStringToMinutes(dayConfig.startTime);
  const cycleEndMin = timeStringToMinutes(dayConfig.endTime);

  const block = blocks.find(b => b.id === resizingId);
  if (!block) return;

  // Ordena os blocos por ordem cronológica
  blocks.sort((a, b) => timeStringToMinutes(a.startTime) - timeStringToMinutes(b.startTime));
  const curIdx = blocks.findIndex(b => b.id === resizingId);

  if (direction === "right") {
    let newEnd = desiredMinutes;
    const blockStart = timeStringToMinutes(block.startTime);
    const nextBlock = blocks[curIdx + 1];

    if (nextBlock) {
      const nextStart = timeStringToMinutes(nextBlock.startTime);
      const nextEnd = timeStringToMinutes(nextBlock.endTime);

      if (newEnd > nextStart) {
        // Expandindo sobre o próximo bloco: encolhe o próximo bloco (limite mín. 5m)
        const maxAllowedEnd = nextEnd - 5;
        newEnd = Math.min(newEnd, maxAllowedEnd);
        newEnd = Math.max(blockStart + 5, newEnd);

        block.endTime = minutesToTimeString(newEnd);
        block.duration = newEnd - blockStart;
        block.actualMinutes = block.duration;

        nextBlock.startTime = minutesToTimeString(newEnd);
        nextBlock.duration = nextEnd - newEnd;
        nextBlock.actualMinutes = nextBlock.duration;

        if (nextBlock.subtasks && nextBlock.subtasks.length > 0) {
          nextBlock.subtasks.forEach(s => {
            if (s.percentage !== undefined && s.percentage !== null) {
              s.duration = Math.max(1, Math.round((s.percentage / 100) * nextBlock.duration));
            }
          });
        }
      } else {
        // Diminuindo o bloco: cria GAP livremente sem alterar o bloco da frente!
        newEnd = Math.max(blockStart + 5, newEnd);
        block.endTime = minutesToTimeString(newEnd);
        block.duration = newEnd - blockStart;
        block.actualMinutes = block.duration;
      }
    } else {
      // Não tem próximo bloco, limita pelo fim do dia e cria gap até o fim
      newEnd = Math.min(cycleEndMin, Math.max(blockStart + 5, newEnd));
      block.endTime = minutesToTimeString(newEnd);
      block.duration = newEnd - blockStart;
      block.actualMinutes = block.duration;
    }
  } else {
    // Redimensionamento pela borda esquerda
    let newStart = desiredMinutes;
    const blockEnd = timeStringToMinutes(block.endTime);
    const prevBlock = blocks[curIdx - 1];

    if (prevBlock) {
      const prevStart = timeStringToMinutes(prevBlock.startTime);
      const prevEnd = timeStringToMinutes(prevBlock.endTime);

      if (newStart < prevEnd) {
        // Expandindo para trás sobre o bloco anterior: comprime o anterior (limite mín. 5m)
        const minAllowedStart = prevStart + 5;
        newStart = Math.max(newStart, minAllowedStart);
        newStart = Math.min(blockEnd - 5, newStart);

        block.startTime = minutesToTimeString(newStart);
        block.duration = blockEnd - newStart;
        block.actualMinutes = block.duration;

        prevBlock.endTime = minutesToTimeString(newStart);
        prevBlock.duration = newStart - prevStart;
        prevBlock.actualMinutes = prevBlock.duration;

        if (prevBlock.subtasks && prevBlock.subtasks.length > 0) {
          prevBlock.subtasks.forEach(s => {
            if (s.percentage !== undefined && s.percentage !== null) {
              s.duration = Math.max(1, Math.round((s.percentage / 100) * prevBlock.duration));
            }
          });
        }
      } else {
        // Diminuindo o bloco pela esquerda: cria GAP livremente sem alterar o anterior!
        newStart = Math.min(blockEnd - 5, newStart);
        block.startTime = minutesToTimeString(newStart);
        block.duration = blockEnd - newStart;
        block.actualMinutes = block.duration;
      }
    } else {
      // Não tem bloco anterior, limita pelo início do dia
      newStart = Math.max(cycleStartMin, Math.min(blockEnd - 5, newStart));
      block.startTime = minutesToTimeString(newStart);
      block.duration = blockEnd - newStart;
      block.actualMinutes = block.duration;
    }
  }

  // Recalcula subtarefas do bloco atual
  if (block.subtasks && block.subtasks.length > 0) {
    block.subtasks.forEach(s => {
      if (s.percentage !== undefined && s.percentage !== null) {
        s.duration = Math.max(1, Math.round((s.percentage / 100) * block.duration));
      }
    });
  }
}
let isResizing = false;
let resizingBlockId = null;
let resizeDirection = null; // 'left' ou 'right'
let resizeStartX = 0;
let resizeOriginalStartMin = 0;
let resizeOriginalEndMin = 0;

function setupResizeHandles() {
  const track = document.getElementById("timelineTrack");

  document.addEventListener("mousedown", (e) => {
    const handle = e.target.closest(".resize-handle");
    if (!handle) return;

    e.preventDefault();
    e.stopPropagation();

    const blockEl = handle.closest(".timeline-block");
    if (!blockEl) return;

    resizingBlockId = blockEl.dataset.id;
    resizeDirection = handle.classList.contains("resize-handle-left") ? "left" : "right";
    isResizing = true;
    resizeStartX = e.clientX;

    const block = blocks.find(b => b.id === resizingBlockId);
    if (block) {
      resizeOriginalStartMin = timeStringToMinutes(block.startTime);
      resizeOriginalEndMin = timeStringToMinutes(block.endTime);
    }

    blockEl.classList.add("resizing");
    handle.classList.add("active");
  });

  document.addEventListener("mousemove", (e) => {
    if (!isResizing || !resizingBlockId) return;

    const trackRect = track.getBoundingClientRect();
    const trackWidth = trackRect.width;
    if (trackWidth <= 0) return;

    const cycleStartMinutes = timeStringToMinutes(dayConfig.startTime);
    const cycleEndMinutes = timeStringToMinutes(dayConfig.endTime);

    const deltaX = e.clientX - resizeStartX;
    const totalDayMinutes = Math.max(30, cycleEndMinutes - cycleStartMinutes);
    const deltaMinutes = (deltaX / trackWidth) * totalDayMinutes;

    const block = blocks.find(b => b.id === resizingBlockId);
    if (!block) return;

    const oldDuration = timeStringToMinutes(block.endTime) - timeStringToMinutes(block.startTime);
    let didChange = false;
    if (resizeDirection === "right") {
      let desiredEnd = snapTo5Minutes(resizeOriginalEndMin + deltaMinutes);
      if (desiredEnd !== timeStringToMinutes(block.endTime)) {
        didChange = true;
      }
      applyDynamicShrinkResize(resizingBlockId, "right", desiredEnd);
    } else {
      let desiredStart = snapTo5Minutes(resizeOriginalStartMin + deltaMinutes);
      if (desiredStart !== timeStringToMinutes(block.startTime)) {
        didChange = true;
      }
      applyDynamicShrinkResize(resizingBlockId, "left", desiredStart);
    }

    if (didChange) {
      const newDuration = timeStringToMinutes(block.endTime) - timeStringToMinutes(block.startTime);
      if (newDuration > oldDuration) {
        SoundFx.expand();
      } else if (newDuration < oldDuration) {
        SoundFx.shrink();
      }
    }

    renderTimeline();
    renderMetrics();
    renderBlocksList();
  });

  document.addEventListener("mouseup", () => {
    if (isResizing) {
      isResizing = false;
      resizingBlockId = null;
      resizeDirection = null;
      document.querySelectorAll(".resizing, .resize-handle.active").forEach(el => {
        el.classList.remove("resizing", "active");
      });
      saveAll();
    }
  });

  // Suporte a Touch para Android / Celular
  document.addEventListener("touchstart", (e) => {
    const handle = e.target.closest(".resize-handle");
    if (!handle) return;

    const touch = e.touches[0];
    const blockEl = handle.closest(".timeline-block");
    if (!blockEl) return;

    resizingBlockId = blockEl.dataset.id;
    resizeDirection = handle.classList.contains("resize-handle-left") ? "left" : "right";
    isResizing = true;
    resizeStartX = touch.clientX;

    const block = blocks.find(b => b.id === resizingBlockId);
    if (block) {
      resizeOriginalStartMin = timeStringToMinutes(block.startTime);
      resizeOriginalEndMin = timeStringToMinutes(block.endTime);
    }

    blockEl.classList.add("resizing");
    handle.classList.add("active");
  }, { passive: false });

  document.addEventListener("touchmove", (e) => {
    if (!isResizing || !resizingBlockId) return;

    const touch = e.touches[0];
    const trackRect = track.getBoundingClientRect();
    const trackWidth = trackRect.width;
    if (trackWidth <= 0) return;

    const cycleStartMinutes = timeStringToMinutes(dayConfig.startTime);
    const cycleEndMinutes = timeStringToMinutes(dayConfig.endTime);

    const deltaX = touch.clientX - resizeStartX;
    const totalDayMinutes = Math.max(30, cycleEndMinutes - cycleStartMinutes);
    const deltaMinutes = (deltaX / trackWidth) * totalDayMinutes;

    const block = blocks.find(b => b.id === resizingBlockId);
    if (!block) return;

    const oldDuration = timeStringToMinutes(block.endTime) - timeStringToMinutes(block.startTime);
    let didChange = false;
    if (resizeDirection === "right") {
      let desiredEnd = snapTo5Minutes(resizeOriginalEndMin + deltaMinutes);
      if (desiredEnd !== timeStringToMinutes(block.endTime)) {
        didChange = true;
      }
      applyDynamicShrinkResize(resizingBlockId, "right", desiredEnd);
    } else {
      let desiredStart = snapTo5Minutes(resizeOriginalStartMin + deltaMinutes);
      if (desiredStart !== timeStringToMinutes(block.startTime)) {
        didChange = true;
      }
      applyDynamicShrinkResize(resizingBlockId, "left", desiredStart);
    }

    if (didChange) {
      const newDuration = timeStringToMinutes(block.endTime) - timeStringToMinutes(block.startTime);
      if (newDuration > oldDuration) {
        SoundFx.expand();
      } else if (newDuration < oldDuration) {
        SoundFx.shrink();
      }
    }

    renderTimeline();
    renderMetrics();
    renderBlocksList();
  }, { passive: false });

  document.addEventListener("touchend", () => {
    if (isResizing) {
      isResizing = false;
      resizingBlockId = null;
      resizeDirection = null;
      document.querySelectorAll(".resizing, .resize-handle.active").forEach(el => {
        el.classList.remove("resizing", "active");
      });
      saveAll();
    }
  });
}

// Modal de Subtarefas
function openSubtasksModal(blockId, source = "timeline") {
  activeBlockId = blockId;
  activeBlockSource = source;

  const blockList = source === "timeline" ? blocks : stagedBlocks;
  const block = blockList.find(b => b.id === blockId);
  if (!block) return;

  const modal = document.getElementById("blockModal");
  const modalBlockTitle = document.getElementById("modalBlockTitle");
  const modalBlockColor = document.getElementById("modalBlockColor");
  const modalTimeRange = document.getElementById("modalTimeRange");
  const modalDuration = document.getElementById("modalDuration");
  const toggleStagedBtn = document.getElementById("toggleStagedBlockBtn");

  modalBlockTitle.textContent = block.title;
  modalBlockColor.style.backgroundColor = block.color;

  if (source === "timeline") {
    modalTimeRange.textContent = `${block.startTime} - ${block.endTime}`;
    modalDuration.textContent = `${formatHoursDecimal((block.actualMinutes || 60) / 60)} de duração`;
    toggleStagedBtn.textContent = "Mover para Espera";
  } else {
    modalTimeRange.textContent = "Não Agendado";
    modalDuration.textContent = `Duração estimada: ${formatHoursDecimal((block.duration || 60) / 60)}`;
    toggleStagedBtn.textContent = "Adicionar à Linha do Tempo";
  }

  renderSubtaskList(block);
  updateModalLibrarySaveButton(block);
  modal.classList.add("active");
  modal.setAttribute("aria-hidden", "false");
  refreshLucideIcons();
}

function getBlockEffectiveDuration(block) {
  if (block.actualMinutes) return block.actualMinutes;
  if (block.startTime && block.endTime) {
    const diff = timeStringToMinutes(block.endTime) - timeStringToMinutes(block.startTime);
    if (diff > 0) return diff;
  }
  return block.duration || 60;
}

// Formata minutos de forma amigável: ex 20m, 1h, 1h 30m, 2h 15m
function formatDurationHuman(minutes) {
  if (!minutes || minutes <= 0) return "0m";
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

// Atualiza o relógio de entrada da subtarefa limitando estritamente ao tempo disponível do bloco
function updateSubtaskDurationOptions(availableMinutes) {
  const timeInput = document.getElementById("newSubtaskDurationTime");
  const submitBtn = document.getElementById("addSubtaskSubmitBtn");
  const input = document.getElementById("newSubtaskInput");
  if (!timeInput) return;

  if (availableMinutes <= 0) {
    timeInput.value = "00:00";
    timeInput.max = "00:00";
    timeInput.disabled = true;
    if (submitBtn) submitBtn.disabled = true;
    if (input) input.disabled = true;
    return;
  }

  timeInput.disabled = false;
  if (submitBtn) submitBtn.disabled = false;
  if (input) input.disabled = false;

  const maxTimeString = minutesToTimeString(availableMinutes);
  timeInput.max = maxTimeString;

  // Se o valor atual for maior que o disponível ou estiver zerado, sugere um valor padrão inteligente
  const currentValMinutes = timeStringToMinutes(timeInput.value);
  if (currentValMinutes <= 0 || currentValMinutes > availableMinutes) {
    if (availableMinutes >= 30) {
      timeInput.value = "00:30";
    } else {
      timeInput.value = maxTimeString;
    }
  }
}

function renderSubtaskList(block) {
  const list = document.getElementById("subtasksList");
  const countTag = document.getElementById("modalSubtasksCount");
  const progressBar = document.getElementById("modalProgressBar");
  const budgetAllocated = document.getElementById("subtasksTotalAllocated");
  const budgetMax = document.getElementById("subtasksBlockMax");
  const errorMsg = document.getElementById("subtaskErrorMsg");

  if (errorMsg) errorMsg.style.display = "none";

  list.innerHTML = "";
  const subtasks = block.subtasks || [];
  const completed = subtasks.filter(s => s.completed).length;
  countTag.textContent = `${completed}/${subtasks.length} concluídas`;

  const pct = subtasks.length > 0 ? (completed / subtasks.length) * 100 : 0;
  progressBar.style.width = `${pct}%`;

  // Calcula tempo total do bloco e tempo alocado nas subtarefas
  const blockTotalMin = getBlockEffectiveDuration(block);
  const totalSubAllocated = subtasks.reduce((sum, s) => sum + (s.duration || 0), 0);
  const availableMinutes = Math.max(0, blockTotalMin - totalSubAllocated);

  if (budgetAllocated) budgetAllocated.textContent = formatDurationHuman(totalSubAllocated);
  if (budgetMax) budgetMax.textContent = formatDurationHuman(blockTotalMin);

  // Atualiza as opções do relógio/seletor de tempo para mostrar EXATAMENTE o tempo disponível
  updateSubtaskDurationOptions(availableMinutes);

  if (subtasks.length === 0) {
    list.innerHTML = `<li style="color: var(--text-dim); font-size: 13px; padding: 8px 0;">Nenhuma subtarefa adicionada ainda. Crie uma acima!</li>`;
    return;
  }

  subtasks.forEach(s => {
    // Garante que s.percentage esteja calculada
    if ((s.percentage === undefined || s.percentage === null) && blockTotalMin > 0) {
      s.percentage = (s.duration / blockTotalMin) * 100;
    }
    const sPct = Math.round(s.percentage || 0);
    const sDuration = s.duration || 0;
    const humanTime = formatDurationHuman(sDuration);

    const li = document.createElement("li");
    li.className = `subtask-item ${s.completed ? "completed" : ""}`;
    li.innerHTML = `
      <input type="checkbox" ${s.completed ? "checked" : ""} data-id="${s.id}">
      <span>${s.text}</span>
      <span class="subtask-duration-badge">${humanTime} <small class="subtask-pct-badge">(${sPct}%)</small></span>
      <button class="subtask-delete-btn" data-id="${s.id}" title="Excluir">&times;</button>
    `;

    li.querySelector('input[type="checkbox"]').addEventListener("change", (e) => {
      s.completed = e.target.checked;
      if (s.completed) {
        SoundFx.complete();
      } else {
        SoundFx.uncomplete();
      }
      saveAll();
      renderSubtaskList(block);
    });

    li.querySelector(".subtask-delete-btn").addEventListener("click", () => {
      SoundFx.delete();
      block.subtasks = block.subtasks.filter(item => item.id !== s.id);
      saveAll();
      renderSubtaskList(block);
    });

    list.appendChild(li);
  });
}

function closeSubtasksModal() {
  SoundFx.close();
  document.getElementById("blockModal").classList.remove("active");
  document.getElementById("blockModal").setAttribute("aria-hidden", "true");
  activeBlockId = null;
}

// Modal de Seleção de Tarefa (Quando a Timeline está vazia)
function openSelectTaskModal() {
  // Se não houver nenhuma tarefa criada em espera nem agendada, abre direto o criador de blocos!
  if (stagedBlocks.length === 0) {
    openEditBlockModal(null);
    return;
  }

  const modal = document.getElementById("selectTaskModal");
  const list = document.getElementById("selectTaskList");
  list.innerHTML = "";

  stagedBlocks.forEach(item => {
    const subCount = item.subtasks ? item.subtasks.length : 0;
    const durHours = (item.duration || 60) / 60;
    const iconSpan = item.icon ? `<span class="select-task-option-icon">${renderAppIcon(item.icon)}</span>` : '';

    const opt = document.createElement("div");
    opt.className = "select-task-option";
    opt.innerHTML = `
      <div class="select-task-option-info">
        ${iconSpan}
        <div>
          <div class="select-task-option-title">${item.title}</div>
          <div class="select-task-option-meta">${formatHoursDecimal(durHours)} • ${subCount} subtarefas</div>
        </div>
      </div>
      <button class="select-task-option-btn">Selecionar</button>
    `;

    opt.addEventListener("click", () => {
      moveStagedToTimeline(item.id);
      closeSelectTaskModal();
    });

    list.appendChild(opt);
  });

  refreshLucideIcons();

  modal.classList.add("active");
  modal.setAttribute("aria-hidden", "false");
}

function closeSelectTaskModal() {
  const modal = document.getElementById("selectTaskModal");
  if (modal) {
    modal.classList.remove("active");
    modal.setAttribute("aria-hidden", "true");
    SoundFx.close();
  }
}

// ==========================================
// BANCO DE DADOS DE MODELOS DE TAREFA (TASK LIBRARY)
// ==========================================

function isBlockInLibrary(block) {
  if (!block) return false;
  // Só considera salvo se foi explicitamente salvo e associado àquele templateId existente
  if (block.templateId) {
    return taskLibrary.some(tpl => tpl.id === block.templateId);
  }
  return false;
}

function updateModalLibrarySaveButton(block) {
  const saveBtn = document.getElementById("saveBlockToDbBtn");
  if (!saveBtn) return;
  const isSaved = isBlockInLibrary(block);
  saveBtn.classList.toggle("saved", isSaved);
  saveBtn.title = isSaved 
    ? "Salvo na Biblioteca (Clique para remover da biblioteca)" 
    : "Salvar na Biblioteca de Tarefas";
}

function toggleBlockInLibrary(blockId, source = "staged") {
  const list = source === "timeline" ? blocks : stagedBlocks;
  const block = list.find(b => b.id === blockId);
  if (!block) return;

  const isSaved = isBlockInLibrary(block);

  if (isSaved) {
    // Remover da Biblioteca
    taskLibrary = taskLibrary.filter(tpl => tpl.id !== block.templateId);
    delete block.templateId;
    saveAll();
    SoundFx.pop(420, 0.05);
    updateModalLibrarySaveButton(block);
    showNotificationFeedback(`"${block.title}" removida da Biblioteca!`);
  } else {
    // Salvar na Biblioteca
    const tplId = "tpl_" + Date.now() + "_" + Math.floor(Math.random() * 1000);
    block.templateId = tplId;

    // Cria cópia pura do modelo sem amarras com os horários dinâmicos de hoje
    const template = {
      id: tplId,
      title: block.title,
      duration: block.duration || 60,
      color: block.color || "#FF4500",
      icon: block.icon || "",
      subtasks: block.subtasks ? block.subtasks.map(s => ({
        id: "tpl_sub_" + Date.now() + "_" + Math.floor(Math.random() * 1000),
        text: s.text,
        duration: s.duration,
        percentage: s.percentage,
        completed: false
      })) : [],
      savedAt: new Date().toISOString()
    };

    taskLibrary.push(template);
    saveAll();
    SoundFx.success();
    updateModalLibrarySaveButton(block);
    showNotificationFeedback(`"${template.title}" salva na Biblioteca!`);
  }
}

function showNotificationFeedback(msg) {
  let toast = document.getElementById("plannerToast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "plannerToast";
    toast.style.position = "fixed";
    toast.style.bottom = "24px";
    toast.style.right = "24px";
    toast.style.background = "#000000";
    toast.style.border = "2px solid #FFFFFF";
    toast.style.color = "#FFFFFF";
    toast.style.boxShadow = "4px 4px 0px #FF4500";
    toast.style.padding = "10px 18px";
    toast.style.fontFamily = "var(--font-condensed)";
    toast.style.fontSize = "16px";
    toast.style.fontWeight = "800";
    toast.style.letterSpacing = "1px";
    toast.style.zIndex = "99999";
    toast.style.clipPath = "polygon(8px 0, 100% 0, calc(100% - 8px) 100%, 0 100%)";
    toast.style.transition = "all 0.2s ease";
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.opacity = "1";
  toast.style.transform = "translateY(0)";

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(10px)";
  }, 2400);
}

function openLibraryModal() {
  const modal = document.getElementById("libraryModal");
  const list = document.getElementById("libraryItemsList");
  const emptyMsg = document.getElementById("libraryEmptyMsg");

  list.innerHTML = "";

  if (taskLibrary.length === 0) {
    emptyMsg.style.display = "block";
  } else {
    emptyMsg.style.display = "none";
    taskLibrary.forEach(tpl => {
      const subCount = tpl.subtasks ? tpl.subtasks.length : 0;
      const durHours = (tpl.duration || 60) / 60;
      const iconSpan = tpl.icon ? renderAppIcon(tpl.icon) : '<i data-lucide="folder" class="app-icon"></i>';

      const card = document.createElement("div");
      card.className = "library-item-card";
      card.innerHTML = `
        <div class="library-item-stripe" style="background-color: ${tpl.color};"></div>
        <div class="library-item-info">
          <div class="library-item-icon" style="background-color: ${tpl.color};">
            ${iconSpan}
          </div>
          <div class="library-item-texts">
            <span class="library-item-title">${tpl.title}</span>
            <span class="library-item-meta">${formatHoursDecimal(durHours)} • ${subCount} subtarefas</span>
          </div>
        </div>
        <div class="library-item-actions">
          <button class="btn-primary-small load-tpl-btn" title="Carregar uma nova cópia desta tarefa para hoje">+ Carregar</button>
          <button class="btn-icon-danger del-tpl-btn" title="Excluir este modelo do Banco de Dados">
            <i data-lucide="trash-2" class="app-icon"></i>
          </button>
        </div>
      `;

      card.querySelector(".load-tpl-btn").addEventListener("click", () => {
        loadTemplateIntoStaged(tpl);
      });

      card.querySelector(".del-tpl-btn").addEventListener("click", () => {
        deleteTemplateFromLibrary(tpl.id);
      });

      list.appendChild(card);
    });
  }

  refreshLucideIcons();
  modal.classList.add("active");
  modal.setAttribute("aria-hidden", "false");
}

function closeLibraryModal() {
  const modal = document.getElementById("libraryModal");
  if (modal) {
    modal.classList.remove("active");
    modal.setAttribute("aria-hidden", "true");
    SoundFx.close();
  }
}

function duplicateBlock(blockId, source = "timeline") {
  const blockList = source === "timeline" ? blocks : stagedBlocks;
  const original = blockList.find(b => b.id === blockId);
  if (!original) return;

  // Gera um título único para evitar conflito com a verificação de duplicata
  let copyIndex = 1;
  let newTitle = `${original.title} (Cópia)`;
  const allCurrentTasks = [...blocks, ...stagedBlocks];
  while (allCurrentTasks.some(t => (t.title || "").trim().toLowerCase() === newTitle.toLowerCase())) {
    copyIndex++;
    newTitle = `${original.title} (Cópia ${copyIndex})`;
  }

  const cycleStartMinutes = timeStringToMinutes(dayConfig.startTime);
  const cycleEndMinutes = timeStringToMinutes(dayConfig.endTime);
  const duration = original.actualMinutes || original.duration || 60;

  // Clona as subtarefas mantendo as durações e resetando o status de conclusão
  const clonedSubtasks = (original.subtasks || []).map(s => ({
    id: "sub_" + Date.now() + "_" + Math.floor(Math.random() * 1000),
    text: s.text,
    duration: s.duration,
    percentage: s.percentage,
    completed: false
  }));

  const duplicatedTask = {
    id: "b_" + Date.now() + "_" + Math.floor(Math.random() * 1000),
    title: newTitle,
    category: original.category || "geral",
    color: original.color || "#FF4500",
    icon: original.icon || "",
    duration: duration,
    actualMinutes: duration,
    locked: false,
    templateId: original.templateId || null,
    subtasks: clonedSubtasks
  };

  if (source === "timeline") {
    // Tenta posicionar logo após o último bloco da timeline se couber
    let startMin = cycleStartMinutes;
    if (blocks.length > 0) {
      const lastBlock = blocks[blocks.length - 1];
      startMin = snapTo5Minutes(timeStringToMinutes(lastBlock.endTime));
      if (startMin + duration > cycleEndMinutes) {
        startMin = Math.max(cycleStartMinutes, cycleEndMinutes - duration);
      }
    }
    duplicatedTask.startTime = minutesToTimeString(startMin);
    duplicatedTask.endTime = minutesToTimeString(startMin + duration);
    blocks.push(duplicatedTask);
  } else {
    stagedBlocks.push(duplicatedTask);
  }

  saveAll();
  SoundFx.success();
  showNotificationFeedback(`Bloco duplicado: "${newTitle}"`);
}

function loadTemplateIntoStaged(tpl) {
  // Verifica se no mesmo dia já não tem uma tarefa idêntica
  const normalizedTitle = (tpl.title || "").trim().toLowerCase();
  const allCurrentDayTasks = [...blocks, ...stagedBlocks];
  const duplicate = allCurrentDayTasks.find(t => (t.title || "").trim().toLowerCase() === normalizedTitle);

  if (duplicate) {
    SoundFx.pop(300, 0.08);
    showNotificationFeedback(`Aviso: já existe uma tarefa "${tpl.title}" neste dia!`);
    return;
  }

  // Instancia uma cópia pura da tarefa para o dia atual a partir do modelo (sem vincular o templateId)
  const newBlock = {
    id: "b_" + Date.now() + "_" + Math.floor(Math.random() * 1000),
    title: tpl.title,
    category: "geral",
    color: tpl.color,
    icon: tpl.icon,
    duration: tpl.duration,
    actualMinutes: tpl.duration,
    subtasks: tpl.subtasks ? tpl.subtasks.map(s => ({
      id: "sub_" + Date.now() + "_" + Math.floor(Math.random() * 1000),
      text: s.text,
      duration: s.duration,
      percentage: s.percentage,
      completed: false
    })) : []
  };

  stagedBlocks.push(newBlock);
  saveAll();
  SoundFx.success();
  showNotificationFeedback(`"${newBlock.title}" carregada para o dia!`);
}

function deleteTemplateFromLibrary(tplId) {
  if (!confirm("Deseja realmente remover este modelo da sua Biblioteca de Tarefas?")) return;
  taskLibrary = taskLibrary.filter(t => t.id !== tplId);
  saveAll();
  SoundFx.delete();
  openLibraryModal();
}

// ==========================================
// MÓDULO DE CALENDÁRIO E HISTÓRICO DE DIAS
// ==========================================

function updateCalendarDateIndicator() {
  const label = document.getElementById("currentViewDateLabel");
  const pastBadge = document.getElementById("calendarPastBadge");
  if (!label) return;

  const todayStr = getTodayDateString();
  const isToday = (selectedViewDate === todayStr);

  if (isToday) {
    label.textContent = "Hoje";
    if (pastBadge) pastBadge.style.display = "none";
  } else {
    // Exibe formato DD/MM
    const [y, m, d] = selectedViewDate.split("-");
    label.textContent = `${d}/${m}`;
    if (pastBadge) {
      pastBadge.style.display = "inline-block";
      pastBadge.textContent = selectedViewDate < todayStr ? "Histórico" : "Futuro";
    }
  }
}

function getDaysWithTasksSet() {
  const daysSet = new Set();

  // Verifica chaves no localStorage
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith("planner_blocks_")) {
        const dStr = key.replace("planner_blocks_", "");
        const raw = localStorage.getItem(key);
        if (raw && raw !== "[]") daysSet.add(dStr);
      }
    }
  } catch (_) {}

  if (!sqliteDb) return daysSet;

  try {
    const res = sqliteDb.exec("SELECT DISTINCT day_date FROM tasks");
    if (res.length > 0) {
      res[0].values.forEach(row => {
        if (row[0]) daysSet.add(row[0]);
      });
    }
  } catch (_) {}

  return daysSet;
}

function renderCalendarDaysGrid() {
  const heading = document.getElementById("calMonthHeading");
  const grid = document.getElementById("calendarDaysGrid");
  if (!heading || !grid) return;

  const months = ["JANEIRO", "FEVEREIRO", "MARÇO", "ABRIL", "MAIO", "JUNHO", "JULHO", "AGOSTO", "SETEMBRO", "OUTUBRO", "NOVEMBRO", "DEZEMBRO"];
  const year = calendarCurrentMonth.getFullYear();
  const month = calendarCurrentMonth.getMonth();

  heading.textContent = `${months[month]} ${year}`;
  grid.innerHTML = "";

  const firstDayOfWeek = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const prevMonthDays = new Date(year, month, 0).getDate();

  const todayStr = getTodayDateString();
  const daysWithTasks = getDaysWithTasksSet();

  // Dias do mês anterior para completar o início da grade
  for (let i = firstDayOfWeek - 1; i >= 0; i--) {
    const dayNum = prevMonthDays - i;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "calendar-day-btn other-month";
    btn.textContent = dayNum;
    btn.disabled = true;
    grid.appendChild(btn);
  }

  // Dias do mês atual
  for (let day = 1; day <= daysInMonth; day++) {
    const monthStr = String(month + 1).padStart(2, "0");
    const dayStr = String(day).padStart(2, "0");
    const dateKey = `${year}-${monthStr}-${dayStr}`;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "calendar-day-btn";
    btn.textContent = day;

    if (dateKey === todayStr) {
      btn.classList.add("is-today");
    }
    if (dateKey === selectedViewDate) {
      btn.classList.add("is-selected");
    }
    if (daysWithTasks.has(dateKey)) {
      btn.classList.add("has-tasks");
    }

    btn.addEventListener("click", () => {
      SoundFx.pop(680, 0.04);
      switchViewDate(dateKey);
      closeCalendarModal();
    });

    grid.appendChild(btn);
  }
}

function switchViewDate(newDateStr) {
  if (selectedViewDate === newDateStr) return;

  // Garante que o estado do dia que estamos saindo seja salvo no SQLite
  persistToSQLite();

  // Carrega o novo dia do SQLite
  loadStateFromSQLite(newDateStr);

  const [y, m, d] = newDateStr.split("-");
  showNotificationFeedback(`Visualizando dia ${d}/${m}/${y}`);
}

function openCalendarModal() {
  const modal = document.getElementById("calendarModal");
  if (!modal) return;

  // Sincroniza o mês do calendário com a data selecionada
  const [y, m] = selectedViewDate.split("-");
  calendarCurrentMonth = new Date(Number(y), Number(m) - 1, 1);

  renderCalendarDaysGrid();
  modal.classList.add("active");
  modal.setAttribute("aria-hidden", "false");
}

function closeCalendarModal() {
  const modal = document.getElementById("calendarModal");
  if (modal) {
    modal.classList.remove("active");
    modal.setAttribute("aria-hidden", "true");
    SoundFx.close();
  }
}

// Categorias com ícones funcionais, universais e sem detalhes poluídos (Lucide Icons)
const ICON_CATEGORIES = [
  {
    name: "Trabalho & Código",
    icons: [
      { id: "laptop", label: "Laptop" },
      { id: "briefcase", label: "Maleta" },
      { id: "code", label: "Código" },
      { id: "terminal", label: "Terminal" },
      { id: "bar-chart-2", label: "Gráfico" },
      { id: "folder", label: "Pasta" },
      { id: "mail", label: "Email" },
      { id: "settings", label: "Configuração" },
      { id: "wrench", label: "Ferramenta" },
      { id: "file-text", label: "Documento" }
    ]
  },
  {
    name: "Estudo & Pesquisa",
    icons: [
      { id: "book-open", label: "Leitura" },
      { id: "flask-conical", label: "Pesquisa" },
      { id: "graduation-cap", label: "Estudo" },
      { id: "edit-3", label: "Escrita" },
      { id: "search", label: "Busca" },
      { id: "target", label: "Foco" },
      { id: "bot", label: "IA" },
      { id: "palette", label: "Design" },
      { id: "compass", label: "Direção" },
      { id: "bookmark", label: "Marcador" }
    ]
  },
  {
    name: "Saúde & Treino",
    icons: [
      { id: "dumbbell", label: "Musculação" },
      { id: "activity", label: "Cardio" },
      { id: "bike", label: "Ciclismo" },
      { id: "heart-pulse", label: "Saúde" },
      { id: "flame", label: "Queima" },
      { id: "footprints", label: "Caminhada" },
      { id: "apple", label: "Nutrição" },
      { id: "trophy", label: "Meta" },
      { id: "pill", label: "Remédio" },
      { id: "timer", label: "Cronômetro" }
    ]
  },
  {
    name: "Casa & Alimentação",
    icons: [
      { id: "home", label: "Casa" },
      { id: "sparkles", label: "Limpeza" },
      { id: "shopping-cart", label: "Compras" },
      { id: "coffee", label: "Café" },
      { id: "utensils", label: "Refeição" },
      { id: "moon", label: "Sono" },
      { id: "shower-head", label: "Banho" },
      { id: "package", label: "Entrega" },
      { id: "check-square", label: "Tarefas" },
      { id: "trash-2", label: "Descarte" }
    ]
  },
  {
    name: "Lazer & Descanso",
    icons: [
      { id: "gamepad-2", label: "Jogos" },
      { id: "headphones", label: "Áudio" },
      { id: "film", label: "Filme" },
      { id: "music", label: "Música" },
      { id: "plane", label: "Viagem" },
      { id: "car", label: "Deslocamento" },
      { id: "sun", label: "Ar Livre" },
      { id: "camera", label: "Foto" },
      { id: "message-square", label: "Conversa" },
      { id: "zap", label: "Energia" }
    ]
  }
];

// Helper para renderizar ícone consistente (SVG ou fallback)
function renderAppIcon(iconName, extraClass = "") {
  if (!iconName) return "";
  // Se for emoji legado salvo em dados antigos
  if (!/^[a-z0-9-]+$/.test(iconName)) {
    return `<span class="app-icon-symbol ${extraClass}">${iconName}</span>`;
  }
  return `<i data-lucide="${iconName}" class="app-icon ${extraClass}"></i>`;
}

function refreshLucideIcons() {
  if (window.lucide && typeof window.lucide.createIcons === "function") {
    window.lucide.createIcons();
  }
}

function setupIconPicker() {
  const iconPickerBtn = document.getElementById("iconPickerBtn");
  const iconDropdown = document.getElementById("iconPickerDropdown");
  const iconGrid = document.getElementById("iconGrid");
  const iconHiddenInput = document.getElementById("blockIconInput");
  const iconDisplay = document.getElementById("selectedIconDisplay");
  const clearBtn = document.getElementById("clearIconBtn");

  // Renderizar categorias com separadores e suas respectivas grades de ícones
  iconGrid.innerHTML = ICON_CATEGORIES.map(cat => {
    const iconsHtml = cat.icons.map(ic => {
      return `
        <button type="button" class="icon-grid-item" data-icon="${ic.id}" title="${ic.label}">
          <i data-lucide="${ic.id}" class="app-icon"></i>
        </button>
      `;
    }).join("");

    return `
      <div class="icon-category-group">
        <div class="icon-category-title">${cat.name}</div>
        <div class="icon-subgrid">
          ${iconsHtml}
        </div>
      </div>
    `;
  }).join("");

  refreshLucideIcons();

  // Abrir / Fechar dropdown
  iconPickerBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const isVisible = iconDropdown.style.display === "block";
    iconDropdown.style.display = isVisible ? "none" : "block";
    if (!isVisible) refreshLucideIcons();
  });

  // Fechar ao clicar fora
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".icon-picker-anchor")) {
      iconDropdown.style.display = "none";
    }
  });

  // Selecionar ícone da grade
  iconGrid.addEventListener("click", (e) => {
    const btn = e.target.closest(".icon-grid-item");
    if (!btn) return;
    SoundFx.pop(700, 0.04);
    const selected = btn.dataset.icon;
    iconHiddenInput.value = selected;
    iconDisplay.innerHTML = renderAppIcon(selected);
    refreshLucideIcons();
    iconDropdown.style.display = "none";

    document.querySelectorAll(".icon-grid-item").forEach(item => {
      item.classList.toggle("selected", item.dataset.icon === selected);
    });
  });

  // Remover ícone
  clearBtn.addEventListener("click", () => {
    iconHiddenInput.value = "";
    iconDisplay.textContent = "Nenhum";
    iconDropdown.style.display = "none";
    document.querySelectorAll(".icon-grid-item").forEach(item => item.classList.remove("selected"));
  });
}

function updateIconPickerUI(currentIcon) {
  const iconHiddenInput = document.getElementById("blockIconInput");
  const iconDisplay = document.getElementById("selectedIconDisplay");
  iconHiddenInput.value = currentIcon || "";
  if (currentIcon) {
    iconDisplay.innerHTML = renderAppIcon(currentIcon);
  } else {
    iconDisplay.textContent = "Nenhum";
  }

  document.querySelectorAll(".icon-grid-item").forEach(item => {
    item.classList.toggle("selected", item.dataset.icon === currentIcon);
  });

  refreshLucideIcons();
}
// Paleta de Cores Pré-definidas do Sistema (Switches Persona / Swiss Brutalism)
const PRESET_COLORS = [
  "#FF4500", // Laranja Internacional / Safety Orange
  "#FF6622", // Laranja Coral
  "#E63900", // Laranja Sangue Intenso
  "#3B82F6", // Azul Persona Elétrico
  "#8B5CF6", // Roxo Neon
  "#10B981", // Verde Tático
  "#F59E0B", // Âmbar / Ocre
  "#EC4899", // Magenta Cyber
  "#E5E5E5", // Off-white Estêncil
  "#444444"  // Grafite Escuro
];

function setupColorSwatches() {
  const container = document.getElementById("colorSwatchesList");
  const colorInput = document.getElementById("blockColorInput");
  if (!container || !colorInput) return;

  container.innerHTML = PRESET_COLORS.map(color => {
    return `<div class="color-swatch-item" data-color="${color}" style="background-color: ${color};" title="${color}"></div>`;
  }).join("");

  container.addEventListener("click", (e) => {
    const swatch = e.target.closest(".color-swatch-item");
    if (!swatch) return;
    const selectedColor = swatch.dataset.color;
    colorInput.value = selectedColor;
    updateActiveSwatch(selectedColor);
    SoundFx.pop(740, 0.04);
  });

  colorInput.addEventListener("input", (e) => {
    updateActiveSwatch(e.target.value);
  });
}

function updateActiveSwatch(selectedColor) {
  const norm = (selectedColor || "").toLowerCase();
  document.querySelectorAll(".color-swatch-item").forEach(item => {
    item.classList.toggle("active", item.dataset.color.toLowerCase() === norm);
  });
}

function openEditBlockModal(blockId = null) {
  editingBlockId = blockId;
  const modal = document.getElementById("editBlockModal");
  const heading = document.getElementById("editModalHeading");
  const titleInp = document.getElementById("blockTitleInput");
  const colorInp = document.getElementById("blockColorInput");
  const scheduleTypeSel = document.getElementById("blockScheduleType");
  const durationTimeInp = document.getElementById("blockDurationTime");
  const durationHidden = document.getElementById("blockDurationInput");

  if (blockId) {
    heading.textContent = "Editar Bloco de Tarefa";
    const b = blocks.find(x => x.id === blockId) || stagedBlocks.find(x => x.id === blockId);
    if (!b) return;

    titleInp.value = b.title;
    colorInp.value = b.color || "#FF4500";
    updateActiveSwatch(colorInp.value);
    updateIconPickerUI(b.icon || "");
    const minutes = b.duration || 60;
    durationHidden.value = minutes;
    durationTimeInp.value = minutesToTimeString(minutes);
    scheduleTypeSel.value = blocks.some(x => x.id === blockId) ? "timeline" : "staged";
  } else {
    heading.textContent = "Novo Bloco de Tarefa";
    titleInp.value = "";
    colorInp.value = "#FF4500";
    updateActiveSwatch("#FF4500");
    updateIconPickerUI("");
    durationHidden.value = 60;
    durationTimeInp.value = "01:00";
    scheduleTypeSel.value = "timeline";
  }

  modal.classList.add("active");
  modal.setAttribute("aria-hidden", "false");
  refreshLucideIcons();
}

function closeEditBlockModal() {
  document.getElementById("editBlockModal").classList.remove("active");
  document.getElementById("editBlockModal").setAttribute("aria-hidden", "true");
  editingBlockId = null;
}

// Funções do Modal de Ciclo do Dia
function openCycleModal() {
  const modal = document.getElementById("cycleModal");
  const startInp = document.getElementById("modalDayStartInput");
  const endInp = document.getElementById("modalDayEndInput");

  startInp.value = dayConfig.startTime;
  endInp.value = dayConfig.endTime;

  modal.classList.add("active");
  modal.setAttribute("aria-hidden", "false");
  refreshLucideIcons();
}

function closeCycleModal() {
  SoundFx.close();
  const modal = document.getElementById("cycleModal");
  if (modal) {
    modal.classList.remove("active");
    modal.setAttribute("aria-hidden", "true");
  }
}

// Configurar Eventos Globais
function setupEvents() {
  // Alternar Snap de 5 minutos
  const snapBtn = document.getElementById("snapToggleBtn");
  if (snapBtn) {
    snapBtn.addEventListener("click", () => {
      isSnapEnabled = !isSnapEnabled;
      if (isSnapEnabled) {
        SoundFx.pop(880, 0.05);
      } else {
        SoundFx.pop(440, 0.05);
      }
      localStorage.setItem("planner_snap_enabled", JSON.stringify(isSnapEnabled));
      syncSnapUI();
    });
  }

  // Abertura do Modal de Ciclo pelo botão de relógio
  document.getElementById("openCycleModalBtn").addEventListener("click", () => {
    SoundFx.open();
    openCycleModal();
  });
  document.getElementById("closeCycleModalBtn").addEventListener("click", closeCycleModal);
  document.getElementById("cancelCycleModalBtn").addEventListener("click", closeCycleModal);
  document.getElementById("cycleModal").addEventListener("click", (e) => {
    if (e.target.id === "cycleModal") closeCycleModal();
  });

  // Presets rápidos dentro do modal de ciclo
  document.querySelectorAll(".preset-pill-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.getElementById("modalDayStartInput").value = btn.dataset.start;
      document.getElementById("modalDayEndInput").value = btn.dataset.end;
    });
  });

  // Salvar formulário do Ciclo do Dia
  document.getElementById("cycleForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const newStart = document.getElementById("modalDayStartInput").value;
    const newEnd = document.getElementById("modalDayEndInput").value;
    const newStartMin = timeStringToMinutes(newStart);
    const newEndMin = timeStringToMinutes(newEnd);

    if (newStartMin >= newEndMin) {
      alert("O horário de início do dia deve ser anterior ao horário de término.");
      return;
    }

    // Verifica se há blocos que ficarão totalmente fora do novo ciclo
    const outOfBoundsBlocks = [];
    const remainingBlocks = [];

    blocks.forEach(b => {
      const bStart = timeStringToMinutes(b.startTime);
      const bEnd = timeStringToMinutes(b.endTime);

      if (bEnd <= newStartMin || bStart >= newEndMin) {
        outOfBoundsBlocks.push(b);
      } else {
        remainingBlocks.push(b);
      }
    });

    if (outOfBoundsBlocks.length > 0) {
      const confirmMove = confirm(
        `Ao encurtar o ciclo, ${outOfBoundsBlocks.length} tarefa(s) ficaram fora do novo horário.\n` +
        `Elas serão movidas automaticamente para a lista de tarefas em espera para preservar seus dados.\n\nDeseja prosseguir?`
      );

      if (!confirmMove) return;

      // Move os blocos fora de alcance para a espera
      outOfBoundsBlocks.forEach(b => {
        stagedBlocks.push(b);
      });
      blocks = remainingBlocks;
    }

    dayConfig.startTime = newStart;
    dayConfig.endTime = newEnd;

    saveAll();
    syncDayInputs();
    renderHoursHeader();
    closeCycleModal();
  });

  // Modal de Subtarefas
  document.getElementById("closeModalBtn").addEventListener("click", closeSubtasksModal);
  document.getElementById("blockModal").addEventListener("click", (e) => {
    if (e.target.id === "blockModal") closeSubtasksModal();
  });

  // Formulário Adicionar Subtarefa com Validação de Tempo Máximo do Bloco
  document.getElementById("addSubtaskForm").addEventListener("submit", (e) => {
    e.preventDefault();
    if (!activeBlockId) return;
    const blockList = activeBlockSource === "timeline" ? blocks : stagedBlocks;
    const block = blockList.find(b => b.id === activeBlockId);
    if (!block) return;

    const input = document.getElementById("newSubtaskInput");
    const durTimeInp = document.getElementById("newSubtaskDurationTime");
    const errorMsg = document.getElementById("subtaskErrorMsg");

    const textVal = input.value.trim();
    const durationVal = timeStringToMinutes(durTimeInp.value);

    if (!textVal) return;

    if (isNaN(durationVal) || durationVal <= 0) {
      errorMsg.textContent = "Insira um tempo de duração válido no relógio (ex: 00:30, 01:00).";
      errorMsg.style.display = "block";
      return;
    }

    const blockMax = getBlockEffectiveDuration(block);
    if (!block.subtasks) block.subtasks = [];

    const currentAllocated = block.subtasks.reduce((sum, s) => sum + (s.duration || 0), 0);
    const available = Math.max(0, blockMax - currentAllocated);

    if (available <= 0) {
      errorMsg.textContent = "Tempo esgotado: este bloco já atingiu 100% da duração alocada.";
      errorMsg.style.display = "block";
      return;
    }

    // Se o valor inserido passar do saldo disponível, ajusta automaticamente para o valor restante disponível
    let finalDuration = durationVal;
    if (finalDuration > available) {
      finalDuration = available;
    }

    errorMsg.style.display = "none";
    SoundFx.pop(750, 0.06);

    block.subtasks.push({
      id: "s_" + Date.now(),
      text: textVal,
      duration: finalDuration,
      percentage: (finalDuration / blockMax) * 100, // Armazena a porcentagem exata que ela representa
      completed: false
    });

    input.value = "";
    saveAll();
    renderSubtaskList(block);
  });

  // Mover entre Linha do Tempo e Espera pelo Modal
  document.getElementById("toggleStagedBlockBtn").addEventListener("click", () => {
    if (!activeBlockId) return;
    if (activeBlockSource === "timeline") {
      moveTimelineToStaged(activeBlockId);
    } else {
      moveStagedToTimeline(activeBlockId);
    }
    closeSubtasksModal();
  });

  // Duplicar Bloco pelo Modal de Detalhes
  const dupBlockBtn = document.getElementById("duplicateBlockBtn");
  if (dupBlockBtn) {
    dupBlockBtn.addEventListener("click", () => {
      if (!activeBlockId) return;
      duplicateBlock(activeBlockId, activeBlockSource);
      closeSubtasksModal();
    });
  }

  // Salvar / Remover Tarefa Atual da Biblioteca de Tarefas pelo Modal de Detalhes
  const saveBlockDbBtn = document.getElementById("saveBlockToDbBtn");
  if (saveBlockDbBtn) {
    saveBlockDbBtn.addEventListener("click", () => {
      if (!activeBlockId) return;
      toggleBlockInLibrary(activeBlockId, activeBlockSource);
    });
  }

  // Abertura e Fechamento do Modal da Biblioteca BD
  const openLibBtn = document.getElementById("openLibraryBtn");
  if (openLibBtn) {
    openLibBtn.addEventListener("click", () => {
      SoundFx.open();
      openLibraryModal();
    });
  }
  const closeLibBtn = document.getElementById("closeLibraryModalBtn");
  if (closeLibBtn) {
    closeLibBtn.addEventListener("click", closeLibraryModal);
  }
  const libraryModal = document.getElementById("libraryModal");
  if (libraryModal) {
    libraryModal.addEventListener("click", (e) => {
      if (e.target.id === "libraryModal") closeLibraryModal();
    });
  }

  // Abertura e Eventos do Modal de Calendário de Dias
  const openCalBtn = document.getElementById("openCalendarModalBtn");
  if (openCalBtn) {
    openCalBtn.addEventListener("click", () => {
      SoundFx.open();
      openCalendarModal();
    });
  }
  const closeCalBtn = document.getElementById("closeCalendarModalBtn");
  if (closeCalBtn) {
    closeCalBtn.addEventListener("click", closeCalendarModal);
  }
  const calendarModal = document.getElementById("calendarModal");
  if (calendarModal) {
    calendarModal.addEventListener("click", (e) => {
      if (e.target.id === "calendarModal") closeCalendarModal();
    });
  }
  const calPrevBtn = document.getElementById("calPrevMonthBtn");
  if (calPrevBtn) {
    calPrevBtn.addEventListener("click", () => {
      SoundFx.pop(540, 0.04);
      calendarCurrentMonth.setMonth(calendarCurrentMonth.getMonth() - 1);
      renderCalendarDaysGrid();
    });
  }
  const calNextBtn = document.getElementById("calNextMonthBtn");
  if (calNextBtn) {
    calNextBtn.addEventListener("click", () => {
      SoundFx.pop(640, 0.04);
      calendarCurrentMonth.setMonth(calendarCurrentMonth.getMonth() + 1);
      renderCalendarDaysGrid();
    });
  }
  // Eventos do Modal de Backup (Exportar e Importar)
  const openBackupBtn = document.getElementById("openBackupModalBtn");
  if (openBackupBtn) {
    openBackupBtn.addEventListener("click", () => {
      SoundFx.open();
      openBackupModal();
    });
  }
  const closeBackupBtn = document.getElementById("closeBackupModalBtn");
  if (closeBackupBtn) {
    closeBackupBtn.addEventListener("click", closeBackupModal);
  }
  const backupModal = document.getElementById("backupModal");
  if (backupModal) {
    backupModal.addEventListener("click", (e) => {
      if (e.target.id === "backupModal") closeBackupModal();
    });
  }
  const exportBtn = document.getElementById("exportBackupBtn");
  if (exportBtn) {
    exportBtn.addEventListener("click", exportFullBackup);
  }
  const importFileInput = document.getElementById("importBackupFileInput");
  if (importFileInput) {
    importFileInput.addEventListener("change", (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) {
        importFullBackup(file);
        e.target.value = "";
      }
    });
  }

  const calGoTodayBtn = document.getElementById("calGoTodayBtn");
  if (calGoTodayBtn) {
    calGoTodayBtn.addEventListener("click", () => {
      SoundFx.pop(700, 0.04);
      switchViewDate(getTodayDateString());
      closeCalendarModal();
    });
  }

  // Excluir Bloco
  document.getElementById("deleteBlockBtn").addEventListener("click", () => {
    if (!activeBlockId) return;
    if (confirm("Tem certeza que deseja remover este bloco e suas subtarefas?")) {
      SoundFx.delete();
      blocks = blocks.filter(b => b.id !== activeBlockId);
      stagedBlocks = stagedBlocks.filter(b => b.id !== activeBlockId);
      saveAll();
      closeSubtasksModal();
    }
  });

  // Editar Bloco
  document.getElementById("editBlockDetailsBtn").addEventListener("click", () => {
    const idToEdit = activeBlockId;
    SoundFx.open();
    closeSubtasksModal();
    openEditBlockModal(idToEdit);
  });

  // Botão Adicionar Bloco
  document.getElementById("addBlockBtn").addEventListener("click", () => {
    SoundFx.open();
    openEditBlockModal(null);
  });

  // Fechar Modal Edição
  document.getElementById("closeEditModalBtn").addEventListener("click", closeEditBlockModal);
  document.getElementById("cancelBlockFormBtn").addEventListener("click", closeEditBlockModal);
  document.getElementById("editBlockModal").addEventListener("click", (e) => {
    if (e.target.id === "editBlockModal") closeEditBlockModal();
  });

  // Modal de Seleção de Tarefa (quando timeline está vazia)
  const closeSelectTaskBtn = document.getElementById("closeSelectTaskModalBtn");
  if (closeSelectTaskBtn) {
    closeSelectTaskBtn.addEventListener("click", closeSelectTaskModal);
  }
  const selectTaskModal = document.getElementById("selectTaskModal");
  if (selectTaskModal) {
    selectTaskModal.addEventListener("click", (e) => {
      if (e.target.id === "selectTaskModal") closeSelectTaskModal();
    });
  }
  const createNewFromEmptyBtn = document.getElementById("createNewFromEmptyBtn");
  if (createNewFromEmptyBtn) {
    createNewFromEmptyBtn.addEventListener("click", () => {
      closeSelectTaskModal();
      openEditBlockModal(null);
    });
  }

  // Submissão do Form de Criar/Editar Bloco
  document.getElementById("blockForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const title = document.getElementById("blockTitleInput").value.trim();
    const category = "geral";
    const color = document.getElementById("blockColorInput").value;
    const icon = document.getElementById("blockIconInput").value.trim();
    const scheduleType = document.getElementById("blockScheduleType").value;

    // Validação de Duplicata: Verifica se no mesmo dia já não existe uma tarefa idêntica
    const normalizedTitle = title.toLowerCase();
    const allCurrentDayTasks = [...blocks, ...stagedBlocks];
    const duplicate = allCurrentDayTasks.find(t => t.id !== editingBlockId && (t.title || "").trim().toLowerCase() === normalizedTitle);

    if (duplicate) {
      SoundFx.pop(300, 0.08);
      alert(`Já existe uma tarefa com o nome "${title}" cadastrada neste dia (na linha do tempo ou em espera). Escolha outro nome.`);
      return;
    }
    
    // Lê a duração diretamente do campo de horário hh:mm para total precisão
    const rawTimeStr = document.getElementById("blockDurationTime").value;
    const calculatedMinutes = timeStringToMinutes(rawTimeStr);
    const duration = Math.max(5, calculatedMinutes || parseInt(document.getElementById("blockDurationInput").value, 10) || 60);

    const cycleStartMinutes = timeStringToMinutes(dayConfig.startTime);
    const cycleEndMinutes = timeStringToMinutes(dayConfig.endTime);
    const totalDayMinutes = Math.max(30, cycleEndMinutes - cycleStartMinutes);
    const validDuration = Math.min(totalDayMinutes, duration);

    if (editingBlockId) {
      // Remover de ambos para recolocar onde o scheduleType mandar
      let existing = blocks.find(x => x.id === editingBlockId) || stagedBlocks.find(x => x.id === editingBlockId);
      blocks = blocks.filter(x => x.id !== editingBlockId);
      stagedBlocks = stagedBlocks.filter(x => x.id !== editingBlockId);

      if (existing) {
        existing.title = title;
        existing.category = category;
        existing.color = color;
        existing.icon = icon;
        existing.duration = validDuration;
        existing.actualMinutes = validDuration;

        if (scheduleType === "timeline") {
          let startMin;
          if (blocks.length > 0) {
            const lastBlock = blocks[blocks.length - 1];
            startMin = snapTo5Minutes(timeStringToMinutes(lastBlock.endTime));
            if (startMin + validDuration > cycleEndMinutes) {
              startMin = Math.max(cycleStartMinutes, cycleEndMinutes - validDuration);
            }
          } else {
            startMin = cycleStartMinutes;
          }
          existing.startTime = minutesToTimeString(startMin);
          existing.endTime = minutesToTimeString(startMin + validDuration);
          blocks.push(existing);
        } else {
          stagedBlocks.push(existing);
        }
      }
    } else {
      let startMin = cycleStartMinutes;
      if (blocks.length > 0) {
        const lastBlock = blocks[blocks.length - 1];
        startMin = snapTo5Minutes(timeStringToMinutes(lastBlock.endTime));
        if (startMin + validDuration > cycleEndMinutes) {
          startMin = Math.max(cycleStartMinutes, cycleEndMinutes - validDuration);
        }
      }

      const newBlock = {
        id: "b_" + Date.now(),
        title,
        category,
        color,
        icon,
        duration: validDuration,
        actualMinutes: validDuration,
        startTime: minutesToTimeString(startMin),
        endTime: minutesToTimeString(startMin + validDuration),
        subtasks: []
      };

      if (scheduleType === "timeline") {
        blocks.push(newBlock);
      } else {
        stagedBlocks.push(newBlock);
      }
    }

    if (scheduleType === "timeline") {
      SoundFx.success();
    } else {
      SoundFx.pop(620, 0.06);
    }

    saveAll();
    closeEditBlockModal();
  });

  // Ações do Modal Central de Fim de Tarefa
  const promptBtnYes = document.getElementById("promptBtnYes");
  const promptBtnNo = document.getElementById("promptBtnNo");

  if (promptBtnYes) {
    promptBtnYes.addEventListener("click", () => {
      if (promptActiveBlock) {
        // Marca todas as subtarefas como concluídas caso haja
        if (promptActiveBlock.subtasks) {
          promptActiveBlock.subtasks.forEach(s => s.completed = true);
        }
        SoundFx.complete();
        saveAll();
      }
      closeTaskEndPrompt();
    });
  }

  if (promptBtnNo) {
    promptBtnNo.addEventListener("click", () => {
      SoundFx.pop(440, 0.05);
      closeTaskEndPrompt();
    });
  }

  // Solicita permissão para notificações do navegador na primeira interação do usuário
  document.addEventListener("click", () => {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  }, { once: true });
}

// Registrar Service Worker para PWA (Android / Navegador offline)
function registerPWA() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

// Inicializar
window.addEventListener("DOMContentLoaded", init);

// ==========================================
// MODULO DE BACKUP (EXPORTAR E IMPORTAR DADOS)
// ==========================================

function openBackupModal() {
  const modal = document.getElementById('backupModal');
  if (!modal) return;
  modal.classList.add('active');
  modal.setAttribute('aria-hidden', 'false');
  refreshLucideIcons();
}

function closeBackupModal() {
  const modal = document.getElementById('backupModal');
  if (modal) {
    modal.classList.remove('active');
    modal.setAttribute('aria-hidden', 'true');
    SoundFx.close();
  }
}

function exportFullBackup() {
  try {
    // Garante que o dia atual foi persistido antes de gerar o dump
    persistToSQLite();

    const backupData = {
      version: 'vodootask_backup_v1',
      exportedAt: new Date().toISOString(),
      selectedViewDate: selectedViewDate || getTodayDateString(),
      taskLibrary: taskLibrary || [],
      dayConfigs: {},
      dayBlocks: {},
      dayStaged: {},
      sqliteBase64: null
    };

    // Coleta dados de todos os dias salvos no localStorage
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      if (key.startsWith('planner_blocks_') && key !== 'planner_blocks_clean') {
        const d = key.replace('planner_blocks_', '');
        try { backupData.dayBlocks[d] = JSON.parse(localStorage.getItem(key)); } catch (_) {}
      } else if (key.startsWith('planner_staged_') && key !== 'planner_staged_blocks_clean') {
        const d = key.replace('planner_staged_', '');
        try { backupData.dayStaged[d] = JSON.parse(localStorage.getItem(key)); } catch (_) {}
      } else if (key.startsWith('planner_day_config_') && key !== 'planner_day_config_v2') {
        const d = key.replace('planner_day_config_', '');
        try { backupData.dayConfigs[d] = JSON.parse(localStorage.getItem(key)); } catch (_) {}
      }
    };

    // Se o SQLite estiver disponível, extrai também todos os dias registrados nas tabelas SQLite para o JSON
    if (sqliteDb) {
      try {
        const allDaysRes = sqliteDb.exec('SELECT DISTINCT day_date FROM tasks UNION SELECT DISTINCT day_date FROM day_config');
        if (allDaysRes.length > 0 && allDaysRes[0].values) {
          allDaysRes[0].values.forEach(row => {
            const d = row[0];
            if (!d) return;
            if (!backupData.dayBlocks[d]) backupData.dayBlocks[d] = [];
            if (!backupData.dayStaged[d]) backupData.dayStaged[d] = [];
          });
        }
      } catch (_) {}
    }

    // Garante dia atual no dump
    backupData.dayBlocks[selectedViewDate] = blocks;
    backupData.dayStaged[selectedViewDate] = stagedBlocks;
    backupData.dayConfigs[selectedViewDate] = dayConfig;

    // Exporta SQLite binario de forma robusta e livre de limite de call stack
    if (sqliteDb) {
      const binaryDb = sqliteDb.export();
      let binaryString = '';
      const chunkSize = 8192;
      for (let i = 0; i < binaryDb.length; i += chunkSize) {
        const chunk = binaryDb.subarray(i, i + chunkSize);
        binaryString += String.fromCharCode.apply(null, chunk);
      }
      backupData.sqliteBase64 = btoa(binaryString);
    }

    const jsonString = JSON.stringify(backupData, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const downloadUrl = URL.createObjectURL(blob);

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const fileName = 'vodootask-backup-' + dateStr + '.json';

    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(downloadUrl);

    SoundFx.success();
    showNotificationFeedback('Backup exportado com sucesso!');
  } catch (err) {
    console.error('Erro ao exportar backup:', err);
    alert('Erro ao gerar arquivo de backup. Verifique o console.');
  }
}

function importFullBackup(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const data = JSON.parse(e.target.result);
      if (!data || (!data.dayBlocks && !data.sqliteBase64 && !data.taskLibrary)) {
        alert('Arquivo de backup invalido ou corrompido.');
        return;
      }

      if (!confirm('Deseja restaurar este backup? ATENCAO: Todas as tarefas e configuracoes atuais serao totalmente substituidas pelas do arquivo importado.')) {
        return;
      }

      // 1. Limpa completamente todos os dados anteriores do planejador no localStorage (Sobrescrita total)
      const keysToRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && (k.startsWith('planner_') || k === 'planner_blocks_clean' || k === 'planner_staged_blocks_clean')) {
          keysToRemove.push(k);
        }
      }
      keysToRemove.forEach(k => localStorage.removeItem(k));

      // 2. Restaura Biblioteca de Modelos
      taskLibrary = Array.isArray(data.taskLibrary) ? data.taskLibrary : [];
      localStorage.setItem('planner_task_library_v1', JSON.stringify(taskLibrary));

      // 3. Restaura todas as tarefas de cada dia e historicos no localStorage
      if (data.dayBlocks && typeof data.dayBlocks === 'object') {
        Object.keys(data.dayBlocks).forEach(d => {
          localStorage.setItem('planner_blocks_' + d, JSON.stringify(data.dayBlocks[d]));
        });
      }
      if (data.dayStaged && typeof data.dayStaged === 'object') {
        Object.keys(data.dayStaged).forEach(d => {
          localStorage.setItem('planner_staged_' + d, JSON.stringify(data.dayStaged[d]));
        });
      }
      if (data.dayConfigs && typeof data.dayConfigs === 'object') {
        Object.keys(data.dayConfigs).forEach(d => {
          localStorage.setItem('planner_day_config_' + d, JSON.stringify(data.dayConfigs[d]));
        });
      }

      // 4. Sobrescreve o SQLite via IndexedDB
      let sqliteRestored = false;
      if (data.sqliteBase64 && typeof initSqlJs === 'function') {
        try {
          const binaryString = atob(data.sqliteBase64);
          const bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }
          const SQL = await initSqlJs({ locateFile: file => file });
          sqliteDb = new SQL.Database(bytes);
          await saveSqliteBytesToIndexedDB(bytes);
          sqliteRestored = true;
        } catch (sqlErr) {
          console.warn('Aviso ao reconstruir SQLite binario, persistindo via estado LocalStorage:', sqlErr);
        }
      }

      // 5. Restaura data alvo e recarrega os dados imediatamente na interface
      const targetDate = data.selectedViewDate || selectedViewDate || getTodayDateString();
      selectedViewDate = targetDate;

      // Se o SQLite esta ativo e nao foi restaurado via binario (ou falhou), popula a partir do JSON
      if (sqliteDb && !sqliteRestored) {
        try {
          sqliteDb.run('DELETE FROM tasks; DELETE FROM day_config; DELETE FROM task_library;');
        } catch (_) {}
      }

      // Se o SQLite está disponível, popula todas as tabelas a partir dos dados do JSON para garantir integridade total
      if (sqliteDb) {
        try {
          sqliteDb.run('DELETE FROM tasks; DELETE FROM day_config; DELETE FROM task_library;');
          // Salva day_configs do JSON
          if (data.dayConfigs) {
            const insCfg = sqliteDb.prepare('INSERT OR REPLACE INTO day_config (day_date, start_time, end_time) VALUES (?, ?, ?)');
            Object.keys(data.dayConfigs).forEach(d => {
              const c = data.dayConfigs[d];
              if (c && c.startTime && c.endTime) insCfg.run([d, c.startTime, c.endTime]);
            });
            insCfg.free();
          }
          // Salva todas as tasks (timeline e staged) de cada dia
          const insTask = sqliteDb.prepare('INSERT OR REPLACE INTO tasks (id, day_date, title, category, color, icon, duration, actual_minutes, start_time, end_time, status, locked, template_id, subtasks_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
          if (data.dayBlocks) {
            Object.keys(data.dayBlocks).forEach(d => {
              const arr = data.dayBlocks[d];
              if (Array.isArray(arr)) {
                arr.forEach(b => {
                  insTask.run([b.id, d, b.title, b.category || 'geral', b.color || '#FF4500', b.icon || '', b.duration || 60, b.actualMinutes || b.duration || 60, b.startTime || '', b.endTime || '', 'timeline', b.locked ? 1 : 0, b.templateId || null, JSON.stringify(b.subtasks || [])]);
                });
              }
            });
          }
          if (data.dayStaged) {
            Object.keys(data.dayStaged).forEach(d => {
              const arr = data.dayStaged[d];
              if (Array.isArray(arr)) {
                arr.forEach(b => {
                  insTask.run([b.id, d, b.title, b.category || 'geral', b.color || '#FF4500', b.icon || '', b.duration || 60, b.actualMinutes || b.duration || 60, '', '', 'staged', 0, b.templateId || null, JSON.stringify(b.subtasks || [])]);
                });
              }
            });
          }
          insTask.free();
          // Salva task_library
          if (Array.isArray(taskLibrary)) {
            const insLib = sqliteDb.prepare('INSERT OR REPLACE INTO task_library (id, title, color, icon, duration, subtasks_json, saved_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
            taskLibrary.forEach(tpl => {
              insLib.run([tpl.id, tpl.title, tpl.color || '#FF4500', tpl.icon || '', tpl.duration || 60, JSON.stringify(tpl.subtasks || []), tpl.savedAt || new Date().toISOString()]);
            });
            insLib.free();
          }
          // Persiste SQLite binário no IndexedDB
          const binaryDb = sqliteDb.export();
          await saveSqliteBytesToIndexedDB(binaryDb);
        } catch (populateErr) {
          console.warn('Erro ao popular tabelas SQLite:', populateErr);
        }
      }

      // Carrega o dia selecionado e atualiza toda a timeline, espera e metricas
      loadStateFromSQLite(selectedViewDate);
      updateCalendarDateIndicator();
      renderAll();
      syncDayInputs();
      renderHoursHeader();

      closeBackupModal();
      SoundFx.success();
      showNotificationFeedback('Backup restaurado! Tudo foi sobrescrito com sucesso.');
      // Força recarregamento limpo da interface após breve feedback
      setTimeout(() => {
        window.location.reload();
      }, 350);
    } catch (err) {
      console.error('Erro ao ler arquivo de backup:', err);
      alert('Falha ao processar o arquivo de backup. Formato JSON invalido.');
    }
  };
  reader.readAsText(file);
}

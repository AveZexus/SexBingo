/* =========================================================
   SexBingo — QR-путь без интернета
   WebRTC P2P через ручное рукопожатие QR-кодами.
   ========================================================= */

(function(){
  'use strict';

  const PREFIX_OFFER  = 'SBQR:O:';
  const PREFIX_ANSWER = 'SBQR:A:';

  // Состояние QR-сессии
  const qr = {
    role: null,          // 'host' | 'player'
    pc: null,            // RTCPeerConnection
    dc: null,            // RTCDataChannel
    // Несколько игроков: map peerId -> { pc, dc, name }
    peers: new Map(),
    // Сканирование
    scanning: false,
    stream: null,
    videoEl: null,
    detector: null,
    timerId: null,
    // Данные, ожидающие обработки
    pendingName: ''
  };

  // ============ UTILS ============
  function log(...args){ console.log('[QR]', ...args); }
  function toast2(msg, ms){ try{ toast(msg, ms); }catch(e){ console.warn(msg); } }
  function showScreenSafe(id){ try{ showScreen(id); }catch(e){ console.warn('showScreen', id, e); } }

  function safeEmit(event, data){
    // Дублируем событие в основной модуль, если он есть
    try{
      if(window.SexBingoNet && SexBingoNet._emit) SexBingoNet._emit(event, data);
    }catch(e){}
  }

  // ============ RENDER QR ============
  function renderQRToContainer(containerId, text){
    const container = document.getElementById(containerId);
    if(!container) return;
    container.innerHTML = '';
    try{
      // qrcode-generator: typeNumber=0 (auto), errorCorrectionLevel='L'
      const gen = qrcode(0, 'L');
      gen.addData(text);
      gen.make();
      const svg = gen.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
      container.innerHTML = svg;
      log('QR ready, length:', text.length);
      return true;
    }catch(err){
      log('QR generation failed:', err);
      container.innerHTML = '<div style="padding:20px;color:#c00;text-align:center;font-size:14px">QR не поместился. Попробуй ещё раз или используй подключение через интернет.</div>';
      return false;
    }
  }

  // ============ WAIT ICE ============
  function waitIceComplete(pc, timeout){
    timeout = timeout || 5000;
    return new Promise(resolve => {
      if(pc.iceGatheringState === 'complete') return resolve();
      let done = false;
      function finish(){
        if(done) return;
        done = true;
        try{ pc.removeEventListener('icegatheringstatechange', onchange); }catch(e){}
        resolve();
      }
      function onchange(){
        if(pc.iceGatheringState === 'complete') finish();
      }
      pc.addEventListener('icegatheringstatechange', onchange);
      setTimeout(finish, timeout);
    });
  }

  // ============ CREATE PEER ============
  function createPc(isInitiator){
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    });
    if(isInitiator){
      const dc = pc.createDataChannel('sexbingo', { ordered: true });
      attachDataChannel(dc, pc);
    } else {
      pc.ondatachannel = (e) => attachDataChannel(e.channel, pc);
    }
    return pc;
  }

  function attachDataChannel(dc, pc){
    qr.dc = dc;
    qr.pc = pc;

    dc.onopen = () => {
      log('DataChannel open');
      // Сообщаем имя ведущему (если мы игрок)
      if(qr.role === 'player'){
        try{
          dc.send(JSON.stringify({ type: 'hello', name: qr.pendingName || 'Игрок' }));
        }catch(e){}
      }
      onConnectionReady();
    };

    dc.onclose = () => {
      log('DataChannel closed');
      safeEmit('peer-lost', { peerId: 'qr', name: qr.pendingName });
    };

    dc.onmessage = (e) => {
      let msg;
      try{ msg = JSON.parse(e.data); }catch{ return; }
      handleDcMessage(msg);
    };
  }

  function handleDcMessage(msg){
    switch(msg.type){
      case 'hello':
        // Хост: игрок представился
        if(qr.role === 'host'){
          qr.pendingName = msg.name || 'Игрок';
          log('Player identified:', qr.pendingName);
          try{ toast('Подключился: ' + qr.pendingName, 1800); }catch(e){}
        }
        break;

      case 'spin':
        // Игрок получил число
        if(qr.role === 'player' && typeof markFromNetwork === 'function'){
          const matched = markFromNetwork(msg.n);
          if(typeof showNetNumber === 'function') showNetNumber(msg.n, matched);
        }
        break;

      case 'reset':
        if(qr.role === 'player' && typeof state !== 'undefined'){
          try{
            const L = layoutOf(state.player.layout);
            state.player.marksW = Array(L.total).fill(false);
            state.player.marksT = Array(L.total).fill(false);
            state.player.bingo = false;
            state.player._bingoSet = [];
            renderPlayer();
            save();
            toast('Новый раунд', 1500);
          }catch(e){}
        }
        break;

      case 'bingo':
        // Хост: игрок объявил бинго
        if(qr.role === 'host'){
          try{ playGong(); }catch(e){}
          const alert = document.getElementById('host-bingo-alert');
          if(alert){
            alert.classList.add('show');
            alert.textContent = '🎉 ' + (msg.name || qr.pendingName || 'Игрок').toUpperCase() + ' — БИНГО!';
          }
          try{ toast('🎉 ' + (msg.name || qr.pendingName || 'Игрок') + ' собрал линию!', 3500); }catch(e){}
        }
        break;
    }
  }

  function onConnectionReady(){
    if(qr.role === 'host'){
      // Хост: соединение с новым игроком установлено
      try{ toast('Игрок подключён', 1500); }catch(e){}
      // Возвращаемся на экран ведущего, чтобы продолжить
      setTimeout(() => {
        showScreenSafe('host');
        try{ netMode = true; netAsHost = true; netAsPlayer = false; }catch(e){}
      }, 800);
    } else {
      // Игрок: соединение с ведущим установлено
      try{ toast('Подключено!', 1500); }catch(e){}
      setTimeout(() => {
        try{ netMode = true; netAsHost = false; netAsPlayer = true; }catch(e){}
        // Куда идти дальше — на карточку игрока или в setup
        try{
          const L = layoutOf(state.player.layout);
          if(state.player.setupDone && state.player.wishes.length === L.total){
            showScreenSafe('player');
          } else {
            showScreenSafe('setup');
          }
        }catch(e){ showScreenSafe('menu'); }
      }, 800);
    }
  }

  // ============ QR HOST — ведущий показывает оффер ============
  async function startHost(){
    qr.role = 'host';
    qr.peers.clear();
    qr.pendingName = '';

    // Показываем экран
    showScreenSafe('net-qr-host');
    document.getElementById('qr-host-hint').textContent = 'Готовим QR…';
    document.getElementById('qr-host-state').textContent = 'Ждём первого игрока';
    document.getElementById('qr-host-state').className = 'qr-stage-state';
    document.getElementById('qr-host-canvas').innerHTML = '';

    try{
      const pc = createPc(true);
      qr.pc = pc;

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitIceComplete(pc, 5000);

      const sdp = JSON.stringify({ sdp: pc.localDescription });
      const compressed = LZString.compressToBase64(sdp);
      const payload = PREFIX_OFFER + compressed;

      if(!renderQRToContainer('qr-host-canvas', payload)){
        return;
      }

      const sizeInfo = payload.length + ' символов';
      document.getElementById('qr-host-hint').textContent =
        'Игрок: «Сетевая игра → Сканировать QR». Держи экраны ближе. ' + sizeInfo;
    }catch(err){
      log('Host error:', err);
      toast2('Не удалось создать QR: ' + err.message, 3000);
      document.getElementById('qr-host-hint').textContent = 'Ошибка: ' + err.message;
    }
  }

  // ============ QR JOIN — игрок сканирует оффер ============
  async function startJoin(){
    qr.role = 'player';
    qr.peers.clear();
    qr.pendingName = 'Игрок';

    const nameInp = document.getElementById('net-join-name');
    if(nameInp && nameInp.value.trim()){
      qr.pendingName = nameInp.value.trim();
    } else {
      // Попробуем взять последнее имя игрока
      try{
        if(state.player.playerName) qr.pendingName = state.player.playerName;
      }catch(e){}
    }

    showScreenSafe('net-qr-scan');
    document.getElementById('qr-scan-hint').textContent = 'Наведи камеру на QR ведущего';
    document.getElementById('qr-scan-sub').textContent = 'НАВЕДИ КАМЕРУ НА QR';

    await scanOnce((value) => {
      handleScannedOffer(value);
    });
  }

  async function handleScannedOffer(value){
    if(!value || value.indexOf(PREFIX_OFFER) !== 0){
      toast2('Это не тот QR. Нужен QR ведущего.', 3000);
      // Пробуем снова
      startJoin();
      return;
    }

    let offer;
    try{
      const compressed = value.slice(PREFIX_OFFER.length);
      const json = LZString.decompressFromBase64(compressed);
      if(!json) throw new Error('не удалось распаковать');
      offer = JSON.parse(json);
    }catch(err){
      log('Offer parse error:', err);
      toast2('QR повреждён, попробуй ещё раз', 3000);
      startJoin();
      return;
    }

    try{
      const pc = createPc(false);
      qr.pc = pc;
      await pc.setRemoteDescription(new RTCSessionDescription(offer.sdp));

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await waitIceComplete(pc, 5000);

      const sdp = JSON.stringify({ sdp: pc.localDescription });
      const compressed = LZString.compressToBase64(sdp);
      const payload = PREFIX_ANSWER + compressed;

      // Показываем экран с ответом
      showScreenSafe('net-qr-answer');
      document.getElementById('qr-answer-hint').textContent = 'Готовим QR…';
      document.getElementById('qr-answer-state').textContent = 'Ждём подтверждения от ведущего';
      document.getElementById('qr-answer-state').className = 'qr-stage-state';

      if(renderQRToContainer('qr-answer-canvas', payload)){
        document.getElementById('qr-answer-hint').textContent =
          'Ведущий сканирует этот QR. Держи экраны ближе. ' + payload.length + ' символов';
      }
    }catch(err){
      log('Offer handling error:', err);
      toast2('Не удалось обработать QR: ' + err.message, 3000);
      startJoin();
    }
  }

  // ============ QR HOST SCAN ANSWER — ведущий сканирует ответ игрока ============
  async function hostScanAnswer(){
    if(!qr.pc){
      toast2('Сначала покажи свой QR игроку', 2500);
      return;
    }
    qr.role = 'host';
    showScreenSafe('net-qr-scan');
    document.getElementById('qr-scan-hint').textContent = 'Наведи камеру на QR-ответ игрока';
    document.getElementById('qr-scan-sub').textContent = 'СКАНИРУЙ ОТВЕТ ИГРОКА';

    await scanOnce((value) => {
      handleScannedAnswer(value);
    });
  }

  async function handleScannedAnswer(value){
    if(!value || value.indexOf(PREFIX_ANSWER) !== 0){
      toast2('Это не ответ игрока. Нужен второй QR.', 3000);
      hostScanAnswer();
      return;
    }
    try{
      const compressed = value.slice(PREFIX_ANSWER.length);
      const json = LZString.decompressFromBase64(compressed);
      if(!json) throw new Error('не удалось распаковать');
      const answer = JSON.parse(json);

      await qr.pc.setRemoteDescription(new RTCSessionDescription(answer.sdp));
      log('Answer set, waiting for connection');

      // Пока ждём открытия DataChannel, вернёмся на экран ведущего QR
      // (соединение установится автоматически, onConnectionReady() сработает)
      showScreenSafe('net-qr-host');
      document.getElementById('qr-host-state').textContent = 'Устанавливаем соединение…';
      document.getElementById('qr-host-state').className = 'qr-stage-state';

      // Дополнительный таймаут на случай проблем
      setTimeout(() => {
        if(qr.dc && qr.dc.readyState === 'open'){
          // всё ок, уже сработал onopen
        } else {
          const state = document.getElementById('qr-host-state');
          if(state && state.textContent.indexOf('Устанавливаем') >= 0){
            state.textContent = 'Долго… Попробуй ещё раз или перезапусти.';
            state.className = 'qr-stage-state err';
          }
        }
      }, 8000);

    }catch(err){
      log('Answer handling error:', err);
      toast2('Ошибка ответа: ' + err.message, 3000);
      hostScanAnswer();
    }
  }

  // ============ SCANNER (камера) ============
  async function scanOnce(onSuccess){
    // Проверяем поддержку
    if(!('BarcodeDetector' in window)){
      alert('Твой браузер не поддерживает сканирование QR прямо в игре.\n\nНужен Chrome для Android версии 83+ или новее.');
      showScreenSafe('net');
      return;
    }

    // Останавливаем прошлое сканирование, если было
    stopScan();

    const video = document.getElementById('qr-scan-video');
    if(!video){
      toast2('Камера недоступна', 3000);
      return;
    }

    qr.videoEl = video;
    qr.scanning = true;

    try{
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: false
      });
      qr.stream = stream;
      video.srcObject = stream;
      await video.play();
    }catch(err){
      log('Camera error:', err);
      toast2('Нет доступа к камере: ' + err.message, 4000);
      showScreenSafe('net');
      return;
    }

    try{
      qr.detector = new BarcodeDetector({ formats: ['qr_code'] });
    }catch(err){
      log('BarcodeDetector init error:', err);
      // Попробуем без параметров
      try{ qr.detector = new BarcodeDetector(); }
      catch(e2){
        toast2('Не удалось запустить сканер', 3000);
        stopScan();
        return;
      }
    }

    function loop(){
      if(!qr.scanning) return;
      qr.detector.detect(qr.videoEl).then(codes => {
        if(!qr.scanning) return;
        if(codes && codes.length > 0){
          const value = codes[0].rawValue;
          log('QR scanned:', value.slice(0, 40) + '…');
          qr.scanning = false;
          stopStream();
          if(navigator.vibrate) navigator.vibrate(40);
          onSuccess(value);
          return;
        }
        qr.timerId = setTimeout(loop, 150);
      }).catch(err => {
        // Иногда detect падает на первых кадрах — просто продолжаем
        if(!qr.scanning) return;
        qr.timerId = setTimeout(loop, 200);
      });
    }
    qr.timerId = setTimeout(loop, 300);
  }

  function stopStream(){
    if(qr.stream){
      qr.stream.getTracks().forEach(t => { try{ t.stop(); }catch(e){} });
      qr.stream = null;
    }
    if(qr.videoEl){
      try{ qr.videoEl.srcObject = null; }catch(e){}
    }
  }

  function stopScan(){
    qr.scanning = false;
    if(qr.timerId){ clearTimeout(qr.timerId); qr.timerId = null; }
    stopStream();
  }

  // ============ CANCEL / LEAVE ============
  function hostCancel(){
    stopScan();
    if(qr.pc){ try{ qr.pc.close(); }catch(e){} qr.pc = null; }
    qr.dc = null;
    qr.peers.clear();
    try{ netMode = false; netAsHost = false; }catch(e){}
    showScreenSafe('net');
  }

  function scanCancel(){
    stopScan();
    showScreenSafe('net');
  }

  function answerCancel(){
    stopScan();
    if(qr.pc){ try{ qr.pc.close(); }catch(e){} qr.pc = null; }
    qr.dc = null;
    try{ netMode = false; netAsPlayer = false; }catch(e){}
    showScreenSafe('net');
  }

  // ============ SEND via DataChannel ============
  function sendToHost(msg){
    if(qr.role !== 'player') return;
    if(qr.dc && qr.dc.readyState === 'open'){
      try{ qr.dc.send(JSON.stringify(msg)); }catch(e){}
    }
  }
  function sendToPlayers(msg){
    if(qr.role !== 'host') return;
    // У хоста может быть несколько игроков (map), но в простой версии — один активный dc
    if(qr.dc && qr.dc.readyState === 'open'){
      try{ qr.dc.send(JSON.stringify(msg)); }catch(e){}
    }
    // Плюс те, кто уже был добавлен в peers (не реализовано в этой версии)
    qr.peers.forEach(entry => {
      if(entry.dc && entry.dc.readyState === 'open'){
        try{ entry.dc.send(JSON.stringify(msg)); }catch(e){}
      }
    });
  }

  // ============ EXPORT ============
  window.netGoQRHost = function(){
    startHost();
  };
  window.netGoQRJoin = function(){
    startJoin();
  };
  window.netQrHostScanAnswer = function(){
    hostScanAnswer();
  };
  window.netQrHostCancel = function(){
    hostCancel();
  };
  window.netQrScanCancel = function(){
    scanCancel();
  };
  window.netQrAnswerCancel = function(){
    answerCancel();
  };

  // Публичный интерфейс для игры
  window.SexBingoQr = {
    spin: function(n){
      if(qr.role === 'host') sendToPlayers({ type: 'spin', n: n });
    },
    reset: function(){
      if(qr.role === 'host') sendToPlayers({ type: 'reset' });
    },
    sendBingo: function(){
      if(qr.role === 'player') sendToHost({ type: 'bingo', name: qr.pendingName });
    },
    isActive: function(){
      return qr.dc && qr.dc.readyState === 'open';
    }
  };

  log('SexBingoQr loaded');
})();

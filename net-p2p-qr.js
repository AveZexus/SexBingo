/* =========================================================
   SexBingo — QR-путь без интернета, МНОГОИГРОВОЙ
   Хост ведёт лобби, подключает до 8 игроков по одному через QR.
   ========================================================= */

(function(){
  'use strict';

  const PREFIX_OFFER  = 'SBQR:O:';
  const PREFIX_ANSWER = 'SBQR:A:';
  const MAX_PLAYERS = 8;

  const qr = {
    role: null,                 // 'host' | 'player'
    peers: new Map(),           // peerId -> { pc, dc, name, connected }
    currentPc: null,            // PeerConnection, для которого сейчас показываем QR
    currentPeerId: null,
    pendingName: '',
    nextPeerId: 1,
    // Сканирование
    scanning: false,
    stream: null,
    videoEl: null,
    detector: null,
    timerId: null
  };

  function log(...args){ console.log('[QR]', ...args); }
  function toast2(msg, ms){ try{ toast(msg, ms); }catch(e){ console.warn(msg); } }
  function showScreenSafe(id){ try{ showScreen(id); }catch(e){ console.warn('showScreen', id, e); } }

  // ============ RENDER QR ============
  function renderQRToContainer(containerId, text){
    const container = document.getElementById(containerId);
    if(!container) return false;
    container.innerHTML = '';
    try{
      const gen = qrcode(0, 'L');
      gen.addData(text);
      gen.make();
      container.innerHTML = gen.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
      log('QR ready, length:', text.length);
      return true;
    }catch(err){
      log('QR generation failed:', err);
      container.innerHTML = '<div style="padding:20px;color:#c00;text-align:center;font-size:14px">QR не поместился. Попробуй подключение через интернет.</div>';
      return false;
    }
  }

  // ============ ICE WAIT ============
  function waitIceComplete(pc, timeout){
    timeout = timeout || 700;
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

  // ============ PEER CREATION ============
  function createPc(isInitiator){
    return new RTCPeerConnection({
      // В локальной сети STUN не нужен. Только host candidates.
      // Это уменьшает SDP в 2-3 раза — иначе QR не помещается.
      iceServers: [],
      iceCandidatePoolSize: 0,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require'
    });
  }

  function attachDataChannel(dc, pc, peerId){
    const entry = { pc, dc, name: '', connected: false };
    qr.peers.set(peerId, entry);

    dc.onopen = () => {
      log('DataChannel open for', peerId);
      entry.connected = true;
      if(qr.role === 'player'){
        // Игрок сообщает имя хосту
        try{ dc.send(JSON.stringify({ type: 'hello', name: qr.pendingName || 'Игрок' })); }catch(e){}
        onPlayerConnected();
      } else if(qr.role === 'host'){
        // Хост: ждём hello от игрока, потом обновим лобби
        // На всякий случай — обновим интерфейс через небольшую задержку
        setTimeout(() => {
          if(!entry.name) entry.name = 'Игрок';
          onHostLobbyUpdate();
        }, 500);
      }
    };

    dc.onclose = () => {
      log('DataChannel closed for', peerId);
      qr.peers.delete(peerId);
      if(qr.role === 'host') onHostLobbyUpdate();
    };

    dc.onmessage = (e) => {
      let msg;
      try{ msg = JSON.parse(e.data); }catch{ return; }
      handleDcMessage(msg, peerId);
    };
  }

  function handleDcMessage(msg, peerId){
    switch(msg.type){
      case 'hello':
        if(qr.role === 'host'){
          const entry = qr.peers.get(peerId);
          if(entry){
            entry.name = (msg.name || 'Игрок').slice(0, 20);
            log('Player identified:', entry.name);
            toast('Подключился: ' + entry.name, 1800);
            onHostLobbyUpdate();
          }
        }
        break;

      case 'spin':
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
        if(qr.role === 'host'){
          const entry = qr.peers.get(peerId);
          const name = (entry && entry.name) || msg.name || 'Игрок';
          try{ playGong(); }catch(e){}
          const alert = document.getElementById('host-bingo-alert');
          if(alert){
            alert.classList.add('show');
            alert.textContent = '🎉 ' + name.toUpperCase() + ' — БИНГО!';
          }
          toast('🎉 ' + name + ' собрал линию!', 3500);
        }
        break;
    }
  }

  function onPlayerConnected(){
    // Игрок: соединение с хостом установлено
    try{ toast('Подключено!', 1500); }catch(e){}
    setTimeout(() => {
      try{
        netMode = true; netAsHost = false; netAsPlayer = true;
      }catch(e){}
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

  // ============ ХОСТ — лобби ============
  function startHost(){
    qr.role = 'host';
    qr.peers.clear();
    qr.currentPc = null;
    qr.currentPeerId = null;
    qr.nextPeerId = 1;
    qr.pendingName = '';
    showHostLobby();
  }

  function showHostLobby(){
    showScreenSafe('net-qr-host');
    document.getElementById('qr-host-qr-state').style.display = 'none';
    const lobby = document.getElementById('qr-host-lobby-state');
    lobby.style.display = 'flex';
    onHostLobbyUpdate();
  }

  function showHostQrState(){
    document.getElementById('qr-host-lobby-state').style.display = 'none';
    const qrState = document.getElementById('qr-host-qr-state');
    qrState.style.display = 'flex';
  }

  function onHostLobbyUpdate(){
    const list = document.getElementById('qr-host-players-list');
    const counter = document.getElementById('qr-host-players-count');
    const startBtn = document.getElementById('qr-host-start-btn');
    if(!list) return;

    const players = [];
    qr.peers.forEach((entry, id) => {
      if(entry.connected) players.push({ id, name: entry.name || 'Игрок' });
    });

    counter.textContent = players.length;

    if(players.length === 0){
      list.innerHTML = '<div class="net-empty">Пока никто. Жми «Добавить игрока».</div>';
    } else {
      list.innerHTML = players.map(p =>
        '<span class="net-player-chip">' + escapeHtml(p.name) + '</span>'
      ).join('');
    }

    // Кнопка "Начать" активна, если есть хоть один игрок
    if(startBtn){
      startBtn.disabled = players.length === 0;
      startBtn.style.opacity = players.length === 0 ? '0.5' : '1';
    }
  }

  function hostAddPlayer(){
    if(qr.peers.size >= MAX_PLAYERS){
      toast2('Максимум ' + MAX_PLAYERS + ' игроков', 2500);
      return;
    }
    addPlayerForCurrentHost();
  }

  async function addPlayerForCurrentHost(){
    const peerId = 'p' + qr.nextPeerId++;
    qr.currentPeerId = peerId;

    showHostQrState();
    document.getElementById('qr-host-step').textContent = 'ШАГ 1 · ПОКАЖИ QR НОВОМУ ИГРОКУ';
    document.getElementById('qr-host-hint').textContent = 'Готовим QR…';
    document.getElementById('qr-host-state').textContent = 'Ждём игрока';
    document.getElementById('qr-host-state').className = 'qr-stage-state';
    document.getElementById('qr-host-canvas').innerHTML = '';

    try{
      const pc = createPc(true);
      qr.currentPc = pc;

      const dc = pc.createDataChannel('sexbingo', { ordered: true });
      attachDataChannel(dc, pc, peerId);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitIceComplete(pc, 5000);

      const sdp = JSON.stringify(pc.localDescription);
      const compressed = LZString.compressToBase64(sdp);
      const payload = PREFIX_OFFER + compressed;

      console.log('[QR] SDP size:', sdp.length, '→ compressed:', payload.length);

      if(payload.length > 2800){
        console.warn('[QR] Payload too big:', payload.length);
        toast('QR получился слишком большим (' + payload.length + ' симв). Пробуем ещё раз…', 3000);
        // Один повтор — иногда ICE успевает собраться меньше
        hostCancelAdd();
        setTimeout(() => addPlayerForCurrentHost(), 500);
        return;
      }

      if(!renderQRToContainer('qr-host-canvas', payload)) return;

      document.getElementById('qr-host-hint').textContent =
        'Игрок: «Сетевая игра → Сканировать QR». Держите экраны рядом. Размер: ' + payload.length;
    }catch(err){
      log('Add player error:', err);
      toast2('Не удалось создать QR: ' + err.message, 3000);
      showHostLobby();
    }
  }

  function hostCancelAdd(){
    // Отменяем текущее добавление — закрываем pc, возвращаемся в лобби
    if(qr.currentPc){
      try{ qr.currentPc.close(); }catch(e){}
      qr.peers.delete(qr.currentPeerId);
      qr.currentPc = null;
      qr.currentPeerId = null;
    }
    showHostLobby();
  }

  function hostStartGame(){
    if(qr.peers.size === 0){
      toast2('Сначала подключи игрока', 2000);
      return;
    }
    try{ netMode = true; netAsHost = true; netAsPlayer = false; }catch(e){}
    // Сбрасываем лог ведущего и переходим на экран
    try{
      state.host.log = [];
      state.host.current = null;
      state.host.round += 1;
      state.host.startedAt = Date.now();
      save();
    }catch(e){}
    showScreenSafe('host');
    toast('Раунд пошёл · спины летят игрокам', 2500);
  }

  // ============ ХОСТ — сканирование ответа ============
  async function hostScanAnswer(){
    if(!qr.currentPc){
      toast2('Сначала создай QR для игрока', 2500);
      return;
    }
    showScreenSafe('net-qr-scan');
    document.getElementById('qr-scan-hint').textContent = 'Наведи камеру на QR-ответ игрока';
    document.getElementById('qr-scan-sub').textContent = 'СКАНИРУЙ ОТВЕТ ИГРОКА';

    await scanOnce((value) => handleScannedAnswer(value));
  }

  async function handleScannedAnswer(value){
    if(!value || value.indexOf(PREFIX_ANSWER) !== 0){
      toast2('Это не ответ игрока. Нужен второй QR.', 3000);
      // Возвращаемся на экран QR и пробуем снова
      showScreenSafe('net-qr-host');
      showHostQrState();
      return;
    }
    try{
      const compressed = value.slice(PREFIX_ANSWER.length);
      const json = LZString.decompressFromBase64(compressed);
      if(!json) throw new Error('не удалось распаковать');
      const answer = JSON.parse(json);

      await qr.currentPc.setRemoteDescription(new RTCSessionDescription(answer));
      log('Answer set, waiting for DataChannel');

      // Показываем экран QR и статус «соединяемся»
      showScreenSafe('net-qr-host');
      showHostQrState();
      document.getElementById('qr-host-state').textContent = 'Устанавливаем соединение…';
      document.getElementById('qr-host-state').className = 'qr-stage-state';
      document.getElementById('qr-host-hint').textContent = 'Держи экраны рядом, соединение завершается.';

      // DataChannel.onopen сам вызовет onHostLobbyUpdate()
      // Плюс защита: если через 12 сек всё ещё нет открытия — подскажем
      const peerId = qr.currentPeerId;
      setTimeout(() => {
        const entry = qr.peers.get(peerId);
        if(!entry || !entry.connected){
          const stateEl = document.getElementById('qr-host-state');
          if(stateEl && stateEl.textContent.indexOf('Устанавливаем') >= 0){
            stateEl.textContent = 'Долго… Попробуй ещё раз или отмени.';
            stateEl.className = 'qr-stage-state err';
          }
        }
      }, 12000);
    }catch(err){
      log('Answer error:', err);
      toast2('Ошибка ответа: ' + err.message, 3000);
      showScreenSafe('net-qr-host');
      showHostQrState();
    }
  }

  // ============ ИГРОК — сканирование оффера ============
  async function startJoin(){
    qr.role = 'player';
    qr.peers.clear();
    qr.currentPc = null;
    qr.currentPeerId = null;

    // Имя игрока
    const nameInp = document.getElementById('net-join-name');
    if(nameInp && nameInp.value.trim()){
      qr.pendingName = nameInp.value.trim();
    } else {
      try{ if(state.player.playerName) qr.pendingName = state.player.playerName; }catch(e){}
      if(!qr.pendingName) qr.pendingName = 'Игрок';
    }

    showScreenSafe('net-qr-scan');
    document.getElementById('qr-scan-hint').textContent = 'Наведи камеру на QR ведущего';
    document.getElementById('qr-scan-sub').textContent = 'НАВЕДИ КАМЕРУ НА QR';

    await scanOnce((value) => handleScannedOffer(value));
  }

  async function handleScannedOffer(value){
    if(!value || value.indexOf(PREFIX_OFFER) !== 0){
      toast2('Это не QR ведущего. Попробуй снова.', 3000);
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
      qr.currentPc = pc;

      // Ждём DataChannel от хоста
      pc.ondatachannel = (e) => {
        attachDataChannel(e.channel, pc, 'host');
      };

 await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await waitIceComplete(pc, 5000);

      const sdp = JSON.stringify(pc.localDescription);
      const compressed = LZString.compressToBase64(sdp);
      const payload = PREFIX_ANSWER + compressed;

      console.log('[QR] Answer SDP size:', sdp.length, '→ compressed:', payload.length);
       
      showScreenSafe('net-qr-answer');
      document.getElementById('qr-answer-hint').textContent = 'Готовим QR…';
      document.getElementById('qr-answer-state').textContent = 'Ждём подтверждения от ведущего';
      document.getElementById('qr-answer-state').className = 'qr-stage-state';

      if(renderQRToContainer('qr-answer-canvas', payload)){
        document.getElementById('qr-answer-hint').textContent =
          'Ведущий сканирует этот QR. Держите экраны рядом.';
      }
    }catch(err){
      log('Offer handling error:', err);
      toast2('Не удалось обработать QR: ' + err.message, 3000);
      startJoin();
    }
  }

  // ============ КАМЕРА / СКАНЕР ============
  async function scanOnce(onSuccess){
    if(!('BarcodeDetector' in window)){
      alert('Твой браузер не поддерживает сканирование QR прямо в игре.\n\nНужен Chrome для Android версии 83+ или новее.');
      showScreenSafe('net');
      return;
    }

    stopScan();

    const video = document.getElementById('qr-scan-video');
    if(!video){
      toast2('Камера недоступна', 3000);
      return;
    }

    qr.videoEl = video;
    qr.scanning = true;

    let stream;
    // Сначала пробуем высокое разрешение — оно лучше для распознавания
    try{
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        },
        audio: false
      });
    }catch(err){
      log('Camera error (high-res):', err);
      try{
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false
        });
      }catch(err2){
        log('Camera error (default):', err2);
        toast2('Нет доступа к камере: ' + err2.message, 4000);
        showScreenSafe('net');
        return;
      }
    }

    qr.stream = stream;
    video.srcObject = stream;
    try{ await video.play(); }catch(e){}

    // ВАЖНО: включаем автофокус. Без этого камера смотрит в бесконечность.
    try{
      const track = stream.getVideoTracks()[0];
      const caps = track.getCapabilities ? track.getCapabilities() : {};
      log('Focus modes:', caps.focusMode);
      if(caps.focusMode && caps.focusMode.indexOf('continuous') >= 0){
        await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
        log('Autofocus: continuous');
      } else if(caps.focusMode && caps.focusMode.indexOf('auto') >= 0){
        await track.applyConstraints({ advanced: [{ focusMode: 'auto' }] });
        log('Autofocus: auto');
      } else {
        log('Autofocus not supported');
      }
    }catch(err){
      log('Focus constraint error (ignore):', err);
    }

    // Ждём 800 мс, пока камера сфокусируется
    await new Promise(r => setTimeout(r, 800));

    try{
      qr.detector = new BarcodeDetector({ formats: ['qr_code'] });
    }catch(err){
      try{ qr.detector = new BarcodeDetector(); }
      catch(e2){
        toast2('Не удалось запустить сканер', 3000);
        stopScan();
        return;
      }
    }

    let attempts = 0;
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
        attempts++;
        if(attempts > 0 && attempts % 30 === 0){
          const hint = document.getElementById('qr-scan-hint');
          if(hint) hint.textContent = 'Приблизь камеру. Держи оба экрана ровно, яркость максимальная.';
        }
        qr.timerId = setTimeout(loop, 120);
      }).catch(() => {
        if(!qr.scanning) return;
        qr.timerId = setTimeout(loop, 200);
      });
    }
    qr.timerId = setTimeout(loop, 100);
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

  // ============ ОТМЕНЫ ============
  function scanCancel(){
    stopScan();
    // Смотрим, откуда пришли: ведущий или игрок
    if(qr.role === 'host') showHostLobby();
    else showScreenSafe('net');
  }

  function answerCancel(){
    stopScan();
    if(qr.currentPc){ try{ qr.currentPc.close(); }catch(e){} qr.currentPc = null; }
    qr.peers.clear();
    try{ netMode = false; netAsPlayer = false; }catch(e){}
    showScreenSafe('net');
  }

  // ============ ОТПРАВКА ============
  function sendToAllPlayers(msg){
    let sent = 0;
    qr.peers.forEach(entry => {
      if(entry.dc && entry.dc.readyState === 'open'){
        try{ entry.dc.send(JSON.stringify(msg)); sent++; }catch(e){}
      }
    });
    return sent;
  }
  function sendToHost(msg){
    qr.peers.forEach(entry => {
      if(entry.dc && entry.dc.readyState === 'open'){
        try{ entry.dc.send(JSON.stringify(msg)); }catch(e){}
      }
    });
  }

  // ============ ЭКСПОРТ ============
  window.netGoQRHost = function(){ startHost(); };
  window.netGoQRJoin = function(){ startJoin(); };
  window.netQrHostScanAnswer = function(){ hostScanAnswer(); };
  window.netQrHostAddPlayer = function(){ hostAddPlayer(); };
  window.netQrHostCancelAdd = function(){ hostCancelAdd(); };
  window.netQrHostStartGame = function(){ hostStartGame(); };
  window.netQrScanCancel = function(){ scanCancel(); };
  window.netQrAnswerCancel = function(){ answerCancel(); };

  window.SexBingoQr = {
    spin: function(n){
      if(qr.role === 'host') return sendToAllPlayers({ type: 'spin', n: n });
      return 0;
    },
    reset: function(){
      if(qr.role === 'host') sendToAllPlayers({ type: 'reset' });
    },
    sendBingo: function(){
      if(qr.role === 'player') sendToHost({ type: 'bingo', name: qr.pendingName });
    },
    isActive: function(){
      let any = false;
      qr.peers.forEach(e => { if(e.connected) any = true; });
      return any;
    },
    playerCount: function(){
      let n = 0;
      qr.peers.forEach(e => { if(e.connected) n++; });
      return n;
    }
  };

  log('SexBingoQr (multi-player) loaded');
})();

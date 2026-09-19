/* =========================================================
   SexBingo — сетевой модуль (часть 1: WebRTC + интернет-путь)
   Публичное API: window.SexBingoNet
   ========================================================= */

(function(){
  'use strict';

  const SIGNALING_URL = 'wss://sexbingo-server.bonto.run';
  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ];

  // ============ STATE ============
  const net = {
    role: null,            // 'host' | 'player'
    myId: null,
    roomCode: null,
    hostName: '',
    playerName: '',
    signaling: null,       // WebSocket
    peers: new Map(),      // peerId -> { pc, dc, name, connected }
    players: new Map(),    // playerId -> name  (для хоста)
    connected: false,
    listeners: {}          // event -> [handlers]
  };

  // ============ EVENT BUS ============
  function on(event, handler){
    if(!net.listeners[event]) net.listeners[event] = [];
    net.listeners[event].push(handler);
  }
  function off(event, handler){
    if(!net.listeners[event]) return;
    net.listeners[event] = net.listeners[event].filter(h => h !== handler);
  }
  function emit(event, data){
    (net.listeners[event] || []).forEach(h => {
      try{ h(data); }catch(e){ console.warn('listener error', event, e); }
    });
  }

  // ============ UTILS ============
  function genId(){
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  }
  function log(...args){
    console.log('[Net]', ...args);
  }

  // ============ SIGNALING ============
  function openSignaling(){
    return new Promise((resolve, reject) => {
      if(net.signaling && net.signaling.readyState === WebSocket.OPEN){
        return resolve(net.signaling);
      }
      let ws;
      try{
        ws = new WebSocket(SIGNALING_URL);
      }catch(e){
        return reject(new Error('Не удалось открыть WebSocket: ' + e.message));
      }
      const t = setTimeout(() => {
        reject(new Error('Сервер не отвечает (таймаут 10 сек)'));
      }, 10000);

      ws.onopen = () => {
        clearTimeout(t);
        net.signaling = ws;
        log('signaling connected');
        resolve(ws);
      };
      ws.onerror = () => {
        clearTimeout(t);
        reject(new Error('Ошибка соединения с сервером'));
      };
      ws.onclose = () => {
        log('signaling closed');
        net.connected = false;
        emit('disconnected');
      };
      ws.onmessage = (e) => {
        let msg;
        try{ msg = JSON.parse(e.data); }catch{ return; }
        handleSignalingMessage(msg);
      };
    });
  }

  function sendSignal(obj){
    if(!net.signaling || net.signaling.readyState !== WebSocket.OPEN) return;
    try{ net.signaling.send(JSON.stringify(obj)); }catch(e){}
  }

  function closeSignaling(){
    if(net.signaling){
      try{ net.signaling.close(); }catch(e){}
      net.signaling = null;
    }
  }

  // ============ WEBRTC ============
  function createPeerConnection(peerId, isInitiator){
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const entry = { pc, dc: null, name: '', connected: false };
    net.peers.set(peerId, entry);

    // ICE candidates — пересылаем через сигналинг
    pc.onicecandidate = (e) => {
      if(e.candidate){
        sendSignal({
          type: 'signal',
          to: peerId,
          payload: { ice: e.candidate }
        });
      }
    };

    pc.onconnectionstatechange = () => {
      log('peer', peerId, 'state:', pc.connectionState);
      if(pc.connectionState === 'failed' || pc.connectionState === 'disconnected'){
        entry.connected = false;
        emit('peer-lost', { peerId, name: entry.name });
      }
    };

    if(isInitiator){
      // Хост создаёт DataChannel
      const dc = pc.createDataChannel('sexbingo', { ordered: true });
      setupDataChannel(peerId, dc);
    } else {
      // Игрок ждёт DataChannel от хоста
      pc.ondatachannel = (e) => {
        setupDataChannel(peerId, e.channel);
      };
    }

    return entry;
  }

  function setupDataChannel(peerId, dc){
    const entry = net.peers.get(peerId);
    if(!entry) return;
    entry.dc = dc;

    dc.onopen = () => {
      log('datachannel open with', peerId);
      entry.connected = true;
      emit('peer-connected', { peerId, name: entry.name });

      // Если мы игрок — сообщаем игре, что готовы
      if(net.role === 'player'){
        net.connected = true;
        emit('connected');
      }
    };

    dc.onclose = () => {
      log('datachannel closed', peerId);
      entry.connected = false;
      emit('peer-lost', { peerId, name: entry.name });
    };

    dc.onmessage = (e) => {
      let msg;
      try{ msg = JSON.parse(e.data); }catch{ return; }
      handleDataMessage(peerId, msg);
    };
  }

  async function initiateOffer(peerId){
    const entry = net.peers.get(peerId);
    if(!entry) return;
    const offer = await entry.pc.createOffer();
    await entry.pc.setLocalDescription(offer);
    sendSignal({
      type: 'signal',
      to: peerId,
      payload: { sdp: entry.pc.localDescription }
    });
  }

  async function handleSignal(fromId, payload){
    let entry = net.peers.get(fromId);

    if(payload.sdp){
      // Входящий offer или answer
      if(!entry){
        // Игрок получает offer от хоста — создаёт peer connection
        entry = createPeerConnection(fromId, false);
      }
      await entry.pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));

      if(payload.sdp.type === 'offer'){
        const answer = await entry.pc.createAnswer();
        await entry.pc.setLocalDescription(answer);
        sendSignal({
          type: 'signal',
          to: fromId,
          payload: { sdp: entry.pc.localDescription }
        });
      }
    } else if(payload.ice){
      if(entry){
        try{
          await entry.pc.addIceCandidate(new RTCIceCandidate(payload.ice));
        }catch(e){ log('ice error', e); }
      }
    }
  }

  // ============ DATA MESSAGES ============
  function broadcastData(msg){
    net.peers.forEach((entry) => {
      if(entry.dc && entry.dc.readyState === 'open'){
        try{ entry.dc.send(JSON.stringify(msg)); }catch(e){}
      }
    });
  }

  function handleDataMessage(fromId, msg){
    switch(msg.type){
      case 'spin':
        // Игрок получает число от ведущего
        emit('spin', { n: msg.n });
        break;

      case 'reset':
        emit('reset');
        break;

      case 'bingo':
        // Хост получает бинго от игрока
        emit('bingo', { playerId: fromId, playerName: msg.name });
        break;

      case 'hello':
        // Обмен именами после соединения
        const entry = net.peers.get(fromId);
        if(entry) entry.name = msg.name || 'Игрок';
        emit('peer-info', { peerId: fromId, name: msg.name });
        break;

      case 'host-info':
        net.hostName = msg.name || 'Ведущий';
        emit('host-info', { name: net.hostName });
        break;
    }
  }

  // ============ SIGNALING MESSAGES ============
  function handleSignalingMessage(msg){
    switch(msg.type){
      case 'room-created':
        net.roomCode = msg.roomCode;
        net.myId = msg.hostId;
        net.role = 'host';
        emit('room-created', { roomCode: msg.roomCode });
        break;

      case 'joined':
        net.roomCode = msg.roomCode;
        net.myId = msg.playerId;
        net.role = 'player';
        net.hostName = msg.hostName || 'Ведущий';
        emit('joined', { roomCode: msg.roomCode, hostName: net.hostName });
        break;

      case 'join-error':
        emit('join-error', { reason: msg.reason });
        break;

      case 'player-joined':
        // Хост: новый игрок вошёл — создаём peer и offer
        net.players.set(msg.playerId, msg.playerName);
        emit('player-joined', { playerId: msg.playerId, playerName: msg.playerName });
        createPeerConnection(msg.playerId, true);
        initiateOffer(msg.playerId);
        break;

      case 'player-left':
        net.players.delete(msg.playerId);
        const entry = net.peers.get(msg.playerId);
        if(entry){
          try{ entry.pc.close(); }catch(e){}
          net.peers.delete(msg.playerId);
        }
        emit('player-left', { playerId: msg.playerId, playerName: msg.playerName });
        break;

      case 'signal':
        handleSignal(msg.from, msg.payload);
        break;

      case 'host-left':
        emit('host-left');
        break;

      case 'player-bingo':
        emit('bingo', { playerId: msg.playerId, playerName: msg.playerName });
        break;

      case 'spin-broadcast':
        emit('spin', { n: msg.n });
        break;

      case 'reset-broadcast':
        emit('reset');
        break;
    }
  }

  // ============ PUBLIC API ============
  async function createRoom(hostName){
    await openSignaling();
    net.role = 'host';
    net.hostName = hostName || 'Ведущий';
    net.myId = genId();
    sendSignal({
      type: 'create',
      hostId: net.myId,
      hostName: net.hostName
    });
  }

  async function joinRoom(roomCode, playerName){
    await openSignaling();
    net.role = 'player';
    net.playerName = playerName || 'Игрок';
    net.myId = genId();
    sendSignal({
      type: 'join',
      roomCode: (roomCode || '').toUpperCase().trim(),
      playerId: net.myId,
      playerName: net.playerName
    });
  }

  function spin(n){
    // Хост: рассылаем число через сигналинг-сервер (быстрее и надёжнее)
    if(net.role !== 'host') return;
    sendSignal({ type: 'spin', n });
    // Дополнительно дублируем через DataChannel — на случай, если сервер отвалится
    broadcastData({ type: 'spin', n });
  }

  function reset(){
    if(net.role !== 'host') return;
    sendSignal({ type: 'reset' });
    broadcastData({ type: 'reset' });
  }

  function sendBingo(){
    if(net.role !== 'player') return;
    sendSignal({ type: 'bingo' });
    broadcastData({ type: 'bingo', name: net.playerName });
  }

  function leave(){
    if(net.signaling && net.signaling.readyState === WebSocket.OPEN){
      sendSignal({ type: 'leave' });
    }
    net.peers.forEach((entry) => {
      try{ entry.pc.close(); }catch(e){}
    });
    net.peers.clear();
    net.players.clear();
    closeSignaling();
    net.role = null;
    net.roomCode = null;
    net.myId = null;
  }

  // Пинг, чтобы сервер не засыпал при активной игре
  setInterval(() => {
    if(net.signaling && net.signaling.readyState === WebSocket.OPEN){
      sendSignal({ type: 'ping' });
    }
  }, 20000);

  // ============ EXPORT ============
  window.SexBingoNet = {
    on, off,
    createRoom, joinRoom,
    spin, reset, sendBingo, leave,
    getState: () => ({
      role: net.role,
      roomCode: net.roomCode,
      myId: net.myId,
      hostName: net.hostName,
      playerName: net.playerName,
      connected: net.connected,
      playersCount: net.peers.size,
      players: Array.from(net.players.entries()).map(([id, name]) => ({ id, name }))
    })
  };

  log('SexBingoNet loaded. Server:', SIGNALING_URL);
})();

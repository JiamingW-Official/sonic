/**
 * Sonic Remote Control — shared protocol constants.
 * Used by relay-server, remote-bridge (desktop), and mobile clients.
 */

// ── Host → Server ──
export const HOST_CREATE_ROOM = 'host:create-room';
export const HOST_KICK = 'host:kick';
export const HOST_STATE_SYNC = 'host:state-sync';
export const HOST_STATE_UPDATE = 'host:state-update';
export const HOST_METER_UPDATE = 'host:meter-update';

// ── Client → Server ──
export const CLIENT_JOIN_ROOM = 'client:join-room';
export const CLIENT_REQUEST_SLOT = 'client:request-slot';
export const CLIENT_RELEASE_SLOT = 'client:release-slot';
export const CLIENT_CONTROL = 'client:control';
export const CLIENT_LEAVE = 'client:leave';

// ── Server → Host ──
export const ROOM_CLIENT_JOINED = 'room:client-joined';
export const ROOM_CLIENT_LEFT = 'room:client-left';
export const ROOM_SLOT_CHANGED = 'room:slot-changed';
export const ROOM_CONTROL = 'room:control';

// ── Server → Client ──
export const CLIENT_ROOM_STATE = 'client:room-state';
export const CLIENT_SLOT_GRANTED = 'client:slot-granted';
export const CLIENT_SLOT_DENIED = 'client:slot-denied';
export const CLIENT_KICKED = 'client:kicked';
export const CLIENT_STATE_SYNC = 'client:state-sync';
export const CLIENT_STATE_UPDATE = 'client:state-update';
export const CLIENT_METER_UPDATE = 'client:meter-update';

// ── Slot names ──
export const SLOT_INSTRUMENT = 'instrument';
export const SLOT_MIXER = 'mixer';
export const SLOT_FX = 'fx';
export const ALL_SLOTS = [SLOT_INSTRUMENT, SLOT_MIXER, SLOT_FX];

// ── Slot display info ──
export const SLOT_INFO = {
  instrument: { label: '乐器', icon: '🎹', color: '#1084d0' },
  mixer:      { label: '混音', icon: '🎚️', color: '#40a040' },
  fx:         { label: '效果器', icon: '🎛️', color: '#d04040' }
};

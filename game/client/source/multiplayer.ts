import {
  PlatformStateSyncClient,
  OnlineRoomSession,
  createOnlineClient,
  createGameClient,
  type RoomPlayer,
  type RoomSnapshot,
  type RoomEventHandlers,
} from '../../../packages/state-sync-runtime/source/client/index.ts'

export {
  PlatformStateSyncClient,
  OnlineRoomSession,
  createOnlineClient,
  createGameClient,
  type RoomPlayer,
  type RoomSnapshot,
  type RoomEventHandlers,
}

export const OnlineClient = OnlineRoomSession
export { createGameClient as default }

import {defineState} from '@forgeax/engine/state';
import type {Loadout,ModeId} from './catalog.ts';
export const Screen=defineState('voxel-frontline/screen',['home','modes','servers','equipment','deployment','battle','pause','results'] as const);
export type ScreenId=typeof Screen.variants[number];
export const SESSION='voxel-frontline/session';
export type Session={mode:ModeId;solo:boolean;classId:string;loadouts:{large:Loadout;small:Loadout};countdown:number;modal:null|'arsenal';slot:'primary'|'secondary'|'gadget1'|'gadget2'|'grenade'|'melee';selectedItem:string;revision:number;message:string};

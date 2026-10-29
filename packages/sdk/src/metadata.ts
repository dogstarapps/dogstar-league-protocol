import type { RoundMetadata } from './types.js';
export function validateMetadata(input: RoundMetadata): RoundMetadata {
  if(input.schemaVersion!==1 || typeof input.name!=='string' || !input.name.trim() || input.name.length>100 || typeof input.description!=='string' || input.description.length>4000 || !input.organizer || typeof input.organizer.name!=='string' || !input.organizer.name.trim() || input.organizer.name.length>100) throw new Error('Invalid round metadata.');
  const organizer={name:input.organizer.name.trim(),bio:input.organizer.bio?.trim(),website:input.organizer.website?.trim()};
  if(organizer.bio && organizer.bio.length>1000)throw new Error('Organizer bio is too long.');
  if(organizer.website){const u=new URL(organizer.website);if(u.protocol!=='https:'||u.username||u.password)throw new Error('Organizer website must use HTTPS without credentials.');}
  return {schemaVersion:1,name:input.name.trim(),description:input.description.trim(),organizer};
}
export function canonicalMetadata(input:RoundMetadata):string {
  const m=validateMetadata(input);
  return JSON.stringify({description:m.description,name:m.name,organizer:{...(m.organizer.bio?{bio:m.organizer.bio}:{}),name:m.organizer.name,...(m.organizer.website?{website:m.organizer.website}:{})},schemaVersion:1});
}
export async function metadataHash(input:RoundMetadata):Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonicalMetadata(input))));
}
export const stringify=(value:unknown)=>JSON.stringify(value,(_key,v)=>typeof v==='bigint'?{$bigint:v.toString()}:v instanceof Uint8Array?{$bytes:Array.from(v)}:v);
export const parse=<T=unknown>(value:string):T=>JSON.parse(value,(_key,v)=>v&&typeof v==='object'&&Object.keys(v).length===1&&typeof v.$bigint==='string'?BigInt(v.$bigint):v&&typeof v==='object'&&Object.keys(v).length===1&&Array.isArray(v.$bytes)?Uint8Array.from(v.$bytes):v) as T;

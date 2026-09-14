/** Distance and motion affect infantry accuracy; core attacks use their own objective rule. */
export function aiHitChance(distance:number,moving:boolean,category='rifle'){
 const effective=category==='sniper'?65:category==='shotgun'?12:category==='pistol'?18:28;
 return Math.max(.015,Math.min(.6,.58/(1+(Math.max(0,distance)/effective)**2)*(moving?.5:1)));
}

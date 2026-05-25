/**
 * @license
 * Cesium - https://github.com/CesiumGS/cesium
 * Version 1.135.0
 *
 * Copyright 2011-2022 Cesium Contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Columbus View (Pat. Pend.)
 *
 * Portions licensed separately.
 * See https://github.com/CesiumGS/cesium/blob/main/LICENSE.md for full licensing details.
 */

const i=Object.create;const u=Object.defineProperty;const r=Object.getOwnPropertyDescriptor;const l=Object.getOwnPropertyNames;const o=Object.getPrototypeOf,c=Object.prototype.hasOwnProperty;const a=(n=>typeof require<"u"?require:typeof Proxy<"u"?new Proxy(n,{get:(e,d)=>(typeof require<"u"?require:e)[d]}):n)(function(n){if(typeof require<"u")return require.apply(this,arguments);throw Error(`Dynamic require of "${n}" is not supported`)}),b=n=>e=>{const d=n[e];if(d)return d();throw new Error(`Module not found in bundle: ${e}`)};const g=(n,e)=>()=>(e||n((e={exports:{}}).exports,e),e.exports);const p=(n,e,d,t)=>{if(e&&typeof e=="object"||typeof e=="function")for(const f of l(e))!c.call(n,f)&&f!==d&&u(n,f,{get:()=>e[f],enumerable:!(t=r(e,f))||t.enumerable});return n};const h=(n,e,d)=>(d=n!=null?i(o(n)):{},p(e||!n||!n.__esModule?u(d,"default",{value:n,enumerable:!0}):d,n));function x(n){return n!=null}const k=x;export{a,b,g as c,h as d,k as e};

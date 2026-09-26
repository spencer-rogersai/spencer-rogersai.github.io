/* ---------- session store ----------
   Saved sessions are large: the residential care file alone runs about 2.8 MB
   as plain text, and browsers allow roughly 5 MB per site in total. Loading two
   products in the same browser therefore used to exceed the ceiling, and the
   second one would report, correctly, that it could not save.

   Compressing before storing takes that 2.8 MB to about 1.1 MB, which leaves
   room for every product at once. Packing costs about a tenth of a second and
   unpacking less, both once per load rather than per interaction.

   Values written this way carry a "gz:" marker. Anything without it is read as
   plain text, so a session saved by an older build still loads, and a browser
   without compression support falls back to plain text and simply stores more. */

var SESSION_GZIP = (typeof CompressionStream !== "undefined" && typeof DecompressionStream !== "undefined");

function bytesToBase64(bytes){
  var bin = "", chunk = 0x8000;
  for(var i = 0; i < bytes.length; i += chunk){
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

async function packSession(text){
  if(!SESSION_GZIP) return text;
  var stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  var bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  return "gz:" + bytesToBase64(bytes);
}

async function unpackSession(stored){
  if(stored === null || stored === undefined) return null;
  if(stored.slice(0, 3) !== "gz:") return stored;          // written before compression, or without support
  if(!SESSION_GZIP) throw new Error("this browser cannot read the compressed session");
  var bytes = Uint8Array.from(atob(stored.slice(3)), function(c){ return c.charCodeAt(0); });
  var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).text();
}

/* Writes are asynchronous, so a later save must never be overwritten by an
   earlier one that finished last. Each key keeps a counter and a stale write
   is discarded. */
var sessionWriteToken = {};

async function writeSession(key, text, onFail){
  var token = (sessionWriteToken[key] = (sessionWriteToken[key] || 0) + 1);
  var payload;
  try { payload = await packSession(text); }
  catch(e){ payload = text; }
  if(sessionWriteToken[key] !== token) return true;        // a newer save is already in flight
  try {
    localStorage.setItem(key, payload);
    return true;
  } catch(e){
    if(onFail) onFail(e);
    return false;
  }
}

async function readSession(key){
  var raw;
  try { raw = localStorage.getItem(key); } catch(e){ return null; }
  if(raw === null) return null;
  try { return await unpackSession(raw); }
  catch(e){
    // A session we cannot decompress is worse than none: drop it rather than
    // leave the product stuck on every load.
    try { localStorage.removeItem(key); } catch(e2){}
    return null;
  }
}

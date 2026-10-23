'use strict';
// Persistent data quotas: zero means unlimited. Transient request queues and
// playback buffers retain separate bounds so they cannot starve audio timing.
function storageLimit(name, fallback=0, value=require('../config')[name]) {
 const n=Number(value??fallback);
 if(!Number.isSafeInteger(n)||n<0)throw new TypeError(name+' must be a nonnegative integer; 0 means unlimited.');
 return n;
}
function retain(items,limit){return limit>0?items.slice(0,limit):items;}
function recent(items,limit){return limit>0?items.slice(-limit):items;}
module.exports={storageLimit,retain,recent};

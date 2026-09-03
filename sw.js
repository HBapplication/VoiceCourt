const CACHE_NAME = 'voicecourt-shell-v3';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './firebase-config.js',
  './manifest.json',
  './logo-v2.png',
  './icon-192-v2.png',
  './icon-512-v2.png'
];

self.addEventListener('install', (event)=>{
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache)=>cache.addAll(APP_SHELL)).then(()=>self.skipWaiting())
  );
});

self.addEventListener('activate', (event)=>{
  event.waitUntil(
    caches.keys().then((keys)=>Promise.all(
      keys.filter((k)=>k!==CACHE_NAME).map((k)=>caches.delete(k))
    )).then(()=>self.clients.claim())
  );
});

// Only cache-first our own app-shell files. Everything else (Firebase Auth/Firestore,
// Google Fonts, the Firebase SDK from gstatic) goes straight to the network so live
// data and authentication are never served stale or blocked by the service worker.
self.addEventListener('fetch', (event)=>{
  const url = new URL(event.request.url);
  const isSameOrigin = url.origin === self.location.origin;
  const isAppShellFile = isSameOrigin && APP_SHELL.some((p)=> url.pathname.endsWith(p.replace('./','/')) || url.pathname==='/' );

  if(event.request.method !== 'GET' || !isSameOrigin){
    return; // let the browser handle it normally (network)
  }

  event.respondWith(
    caches.match(event.request).then((cached)=>{
      const networkFetch = fetch(event.request).then((response)=>{
        if(response && response.ok && isAppShellFile){
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache)=>cache.put(event.request, copy));
        }
        return response;
      }).catch(()=>cached);
      return cached || networkFetch;
    })
  );
});

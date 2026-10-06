// Set install metadata before asynchronous app boot, even during a DB outage.
(() => {
 const hostname=location.hostname.toLowerCase()
 const slug=hostname.match(/^(gbig|appleton)(?:-app)?(?:-[a-z0-9-]+)?\.vercel\.app$/)?.[1] || hostname.split('.')[0].replace(/-app$/,'')
 const names={gbig:'Green Bay Indoor Golf',appleton:'Appleton Indoor Golf'}
 if(!names[slug])return
 document.title=names[slug]
 document.querySelector('meta[name="apple-mobile-web-app-title"]').content=names[slug]
 document.querySelector('link[rel="apple-touch-icon"]').href=`/branding/${slug}-icon-apple.png`
 document.querySelectorAll('link[rel="icon"]').forEach(el=>{el.type='image/png';el.href=`/branding/${slug}-icon-192.png`})
})()

// ---------------------------------------------------------------------------------------------
// "About this copy": version info, and (when served from the web) a link to download the single-file offline copy.
(function aboutThisCopy() {
  const hosted = /^https?:$/.test(location.protocol);
  const build = typeof BUILD !== 'undefined' ? BUILD : null;
  if (build) $('aboutBuild').textContent = `Hillberry PhotoMan ${build.version}, built ${build.date}${build.sha ? ' (' + build.sha + ')' : ''}.`;
  $('aboutHosted').hidden = !hosted;
  $('offlineLinkRow').hidden = !hosted;
  $('aboutOffline').hidden = hosted;
  if (!hosted && build && build.site) {
    $('aboutLatest').hidden = false;
    const a = $('aboutLatestLink');
    a.href = build.site + '/';
    a.textContent = build.site.replace(/^https?:\/\//, '');
  }
})();

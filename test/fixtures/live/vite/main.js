// counts full loads, so a hot update can be told from a reload
sessionStorage.loads = Number(sessionStorage.loads ?? 0) + 1;
document.getElementById('m').dataset.ready = '1';

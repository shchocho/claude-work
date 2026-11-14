// 첫 화면이 그려지기 전에 테마를 정한다. (저장된 선택 → 없으면 OS 설정)
(function () {
  var saved = null;
  try {
    saved = localStorage.getItem('mrc.theme');
  } catch (e) {
    /* 저장소를 쓸 수 없으면 OS 설정을 따른다 */
  }
  var dark = saved ? saved === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
})();

try {
  var t = localStorage.getItem('fluent.theme');
  if (t === 'light') document.documentElement.classList.add('light-theme');
  else if (t === 'dark') document.documentElement.classList.add('dark-theme');
} catch (e) {}

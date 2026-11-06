(function () {
  var data = JSON.parse(document.getElementById('data').textContent);
  var box = document.getElementById('msgs');
  marked.setOptions({ gfm: true, breaks: true });
  data.messages.forEach(function (m) {
    var el = document.createElement('div');
    el.className = 'msg ' + m.role;
    if (m.role === 'user') {
      el.textContent = m.text;
    } else {
      // Artifact tags are shown as plain code blocks in the read-only view.
      var text = m.text.replace(/<artifact\b[^>]*title="([^"]*)"[^>]*>([\s\S]*?)(<\/artifact>|$)/g, function (_, title, body) {
        return '\n\n**' + title + '**\n\n```\n' + body.trim() + '\n```\n\n';
      });
      el.innerHTML = DOMPurify.sanitize(marked.parse(text));
      el.querySelectorAll('pre code').forEach(function (c) { try { hljs.highlightElement(c); } catch (e) {} });
      el.querySelectorAll('a').forEach(function (a) { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
      if (m.model) {
        var meta = document.createElement('div');
        meta.className = 'model';
        meta.textContent = m.model;
        el.appendChild(meta);
      }
    }
    box.appendChild(el);
  });
})();

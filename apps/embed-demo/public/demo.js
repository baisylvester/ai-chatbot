// Reads ?bot=cb_…&api=http://localhost:3100 so the same demo pages work with any chatbot.
(function () {
  var params = new URLSearchParams(location.search);
  window.DEMO = {
    bot: params.get("bot") || "",
    api: (params.get("api") || "http://localhost:3100").replace(/\/+$/, ""),
  };
  document.addEventListener("DOMContentLoaded", function () {
    var nav = document.getElementById("nav");
    if (nav) {
      ["index.html", "web-component.html", "iframe.html"].forEach(function (page) {
        var a = document.createElement("a");
        a.href = page + location.search;
        a.textContent = page;
        nav.appendChild(a);
        nav.appendChild(document.createTextNode(" "));
      });
    }
    if (!window.DEMO.bot) {
      var warn = document.createElement("p");
      warn.className = "warn";
      warn.textContent = "Add ?bot=cb_… (and optionally &api=…) to the URL.";
      document.body.prepend(warn);
    }
  });
})();

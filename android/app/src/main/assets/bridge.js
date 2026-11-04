// Runs on www.flouna.com only. A WebView has no share sheet and ignores download
// links, so both are handed to the app through the FlounaApp message channel.
(function () {
  if (!window.FlounaApp) return;
  var send = function (message) {
    window.FlounaApp.postMessage(JSON.stringify(message));
  };

  navigator.share = function (data) {
    data = data || {};
    send({
      type: "share",
      title: data.title || "",
      text: [data.text, data.url].filter(Boolean).join(" "),
    });
    return Promise.resolve();
  };
  // Files go through the download path below.
  navigator.canShare = function (data) {
    return !(data && data.files && data.files.length);
  };

  // Has the shape of the web's speech API, for the voice buttons already on the
  // site. The app does the listening; only one recogniser runs at a time.
  var listening = null;
  window.FlounaApp.onmessage = function (event) {
    var message = JSON.parse(event.data);
    var rec = listening;
    if (!rec) return;
    if (message.event === "result" && rec.onresult) {
      var result = [{ transcript: message.text }];
      result.isFinal = message.isFinal;
      rec.onresult({ results: [result] });
    } else if (message.event === "error" && rec.onerror) {
      rec.onerror({ error: message.text });
    } else if (message.event === "end") {
      listening = null;
      if (rec.onend) rec.onend();
    }
  };
  var Speech = function () {
    this.lang = "";
    this.interimResults = false;
    this.continuous = false;
    this.onresult = this.onend = this.onerror = null;
  };
  Speech.prototype.start = function () {
    listening = this;
    send({ type: "speech-start", lang: this.lang });
  };
  Speech.prototype.stop = function () {
    send({ type: "speech-stop" });
  };
  Speech.prototype.abort = function () {
    send({ type: "speech-abort" });
    if (listening === this) listening = null;
  };
  window.SpeechRecognition = window.webkitSpeechRecognition = Speech;

  var download = function (link) {
    fetch(link.href)
      .then(function (response) {
        return response.blob();
      })
      .then(function (blob) {
        var reader = new FileReader();
        reader.onload = function () {
          send({
            type: "download",
            name: link.download,
            mime: blob.type || "application/octet-stream",
            data: String(reader.result).split(",")[1] || "",
          });
        };
        reader.readAsDataURL(blob);
      });
  };

  // The site builds most downloads as a link it never adds to the page, then
  // calls click() on it, so a listener on the document would never see them.
  var click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.hasAttribute("download")) return download(this);
    return click.call(this);
  };
  document.addEventListener(
    "click",
    function (event) {
      var link = event.target.closest && event.target.closest("a[download]");
      if (!link) return;
      event.preventDefault();
      download(link);
    },
    true,
  );
})();

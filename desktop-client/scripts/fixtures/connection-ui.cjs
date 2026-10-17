const { app, BrowserWindow, nativeTheme } = require("electron");
const assert = require("node:assert/strict");
const path = require("node:path");

app.setPath("userData", process.env.SKYLAB_CONNECTION_TEST_DIR);
app.disableHardwareAcceleration();
// Keep Electron alive between the dark and light theme windows.
app.on("window-all-closed", () => {});
app
  .whenReady()
  .then(async () => {
    let scenarios = 0;
    for (const theme of ["dark", "light"]) {
      nativeTheme.themeSource = theme;
      const win = new BrowserWindow({
        width: 960,
        height: 700,
        show: false,
        webPreferences: {
          preload: path.join(__dirname, "connection-ipc.cjs"),
          sandbox: true,
          backgroundThrottling: false
        }
      });
      await win.loadFile(path.resolve(__dirname, "../../dist/index.html"));
      await win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{
      const start=Date.now(); const timer=setInterval(()=>{
        if(document.querySelector('.connection-banner .is-running')){clearInterval(timer);resolve()}
        else if(Date.now()-start>10000){clearInterval(timer);reject(new Error('Connected UI did not initialize'))}
      },30)
    })`);
      const settle = () =>
        win.webContents.executeJavaScript(
          "new Promise(resolve=>setTimeout(resolve,0))"
        );
      const inspect = () =>
        win.webContents.executeJavaScript(`(()=>{
      const banner=document.querySelector('.connection-banner');
      return {error:banner.classList.contains('connection-banner--error'),
        title:banner.querySelector('h2').textContent,
        border:getComputedStyle(banner).borderColor,
        icon:getComputedStyle(banner.querySelector('.material-icons-outlined')).color,
        alerts:document.querySelectorAll('.sl-notice--danger').length}
    })()`);
      const normal = await inspect();
      assert.equal(normal.error, false);
      for (const [route, code] of [
        ["system/openRdp", "B1018"],
        ["system/openRdp", "B1019"],
        ["system/openRdp", "B1020"],
        ["system/openSsh", "B1018"],
        ["tunnel/refresh", "B1017"],
        ["resource/listMyResources", "B1017"]
      ]) {
        await win.webContents.executeJavaScript(
          `window.connectionTestReply(${JSON.stringify(route + ":hook")},null,${JSON.stringify(code)})`
        );
        await settle();
        const failure = await inspect();
        assert.equal(failure.error, false, `${theme}: ${route} ${code}`);
        assert.equal(failure.title, normal.title);
        assert.equal(failure.border, normal.border);
        assert.equal(failure.icon, normal.icon);
        if (code === "B1018") assert.ok(failure.alerts > 0);
        scenarios++;
      }
      await win.webContents
        .executeJavaScript(`window.connectionTestReply('tunnel/getStatus:hook',{
      running:false,connected:false,connectionError:'Disconnected',connectionErrorCode:'B1005',tunnels:[]
    })`);
      await settle();
      const disconnected = await inspect();
      assert.equal(disconnected.error, true);
      assert.notEqual(disconnected.title, normal.title);
      scenarios++;
      win.destroy();
    }
    console.log(
      `Connection UI: ${scenarios} scenarios passed in dark and light themes.`
    );
    app.exit(0);
  })
  .catch(error => {
    console.error(error);
    app.exit(1);
  });

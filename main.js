const { app, BrowserWindow } = require('electron');
const path = require('path');

// Desactivar aceleración por hardware y GPU a nivel de línea de comandos
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.disableHardwareAcceleration();

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "Sistema POS BENEMEX",
    icon: path.join(__dirname, 'logo-home-cut.jpg'),
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  win.loadFile('index.html');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

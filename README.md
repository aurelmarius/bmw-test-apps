# BMW iDrive 7 Test Apps (MGU)

> [!WARNING]
> **The apps in this repository are still being designed and tested.**
> They are published here only so they can be installed straight from the Store for testing in
> the car. They may not work, may not work on your car, may behave differently from one version
> to the next, and may send commands to the car's control units. Use them at your own risk. Only
> test them while the car is parked, and don't rely on them.
>
> Apps that work well move to **[aurelmarius/bmw-apps](https://github.com/aurelmarius/bmw-apps)**.
> That is the repository to use for everyday apps.

Custom applications for BMW iDrive 7 (MGU head units), compatible with **Robert Nisipeanu's
mgu-store** and **IterioDev's App Manager**. Built with the same kit as
[aurelmarius/bmw-apps](https://github.com/aurelmarius/bmw-apps).

---

## 🧪 Apps being tested

### 🔥 Wheel Heating (`aurelm_wheel_heat`)
*Steering wheel heating on/off from a favourite button.*

**Status:** first in-car test. Not known yet which of the three ways of switching works.

For an iDrive 7 car fitted with a heated iDrive 8 (LCI) steering wheel. That wheel has no heating button, and on iDrive 7 only the voice command could switch it. The app tries to switch it the way the voice command does, through the head unit's climate service (`ClimateMaster.requestSteeringWheelHeating`). If the climate service turns the request down, the app writes the level to the climate service's status field (`statusSteeringWheelHeating`, which has a setter), and then tries the steering wheel's own service (`SteeringWheelClimate.requestHeating`).

* **Favourite button shortcut**: highlight *Wheel Heating* in the apps menu and hold a favourite button (1-8) to save it. Each press then switches the heating on or off (setting: switch on / off, always on, or only show the status).
* **Status screen**: on / off as the car reports it, with an on / off button.
* **Details page**: what both services report (available, level, coding) and every request sent with the car's answer. **Take a photo of this page when you report a test.**
* **Client group**: which client group the climate service accepts from an app is not documented. When the climate service turns a request down, the app tries groups 0-7 and keeps the one it accepts (setting).
* **Screen after a favourite button** (setting): show the status screen, or stay on the current screen.

![Wheel Heating - status](docs/screenshots/aurelm_wheel_heat-status.png)
![Wheel Heating - details](docs/screenshots/aurelm_wheel_heat-details.png)
<sub>Screenshots drawn by the app on a PC with a simulated car.</sub>

---

## 🚀 Installation

### Via mgu-store
1. Open **Store** on your BMW central display.
2. Go to **Settings** -> **Add source**.
3. Enter:
   ```text
   aurelmarius/bmw-test-apps
   ```
4. Select **Releases** as the source type.
5. Tap **Install** next to the app you want to test.

### Via USB stick
1. Download `<id>@<version>.tgz` from [Releases](https://github.com/aurelmarius/bmw-test-apps/releases).
2. Build a USB repository:
   ```powershell
   node mgu-install.js usb-repo E:\ aurelm_wheel_heat@1.0.1.tgz
   ```
3. Insert the USB drive into your car and install from the **USB** page of the Store.

### Via SSH
```bash
/var/opt/mgu-deploy/mgu-deploy.sh install --artifact aurelm_wheel_heat@1.0.1.tgz --yes
```

---

## 🛠️ Development

```bash
python3 kit/tools/build.py aurelm_wheel_heat          # -> dist/aurelm_wheel_heat@<version>.tgz
node tests/aurelm_wheel_heat.test.js                  # Wheel Heating's switching against a simulated car
cp dist/aurelm_wheel_heat@<version>.tgz packages/     # a push to main with a new package publishes a release
```

App ids start with `aurelm_`, as in [bmw-games](https://github.com/aurelmarius/bmw-games): ids are global on the
head unit, and the Store's publishing guide asks for a prefix of one's own. Each app has its own
`<id>.png` icon at the repository root, which the release carries for the Store.

A push to `main` that changes `packages/` publishes a release straight away (no draft), so the Store
offers it at once. To withdraw a release, run the **Retire Releases** workflow: it marks the release
a pre-release, which the Store doesn't offer.

**Kit**: `kit/` is the [iDrive 7 custom apps](https://github.com/cauliflowermossgrape/idrive7-apps) kit (MIT), with the packaging changes from bmw-apps.

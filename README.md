# pi-refuseless-tether

Use [Refuseless](https://refuseless.com) models in [Pi](https://pi.dev) with a validated API-key login, a live model catalog, and credit and cost information in Pi.

## Install

Requires Node.js 22 or newer, Pi 1.5.2 or newer, and a Refuseless API key. Requests use your Refuseless account.

```sh
pi install npm:pi-refuseless-tether
```

In Pi, open `/login`, pick **Refuseless API key**, and paste your key. The provider checks the key before Pi saves it. To supply the key through your environment instead, set `REFUSELESS_API_KEY`.

Choose **Refuseless** in `/model`, or use `pi --list-models refuseless` to see the model IDs available to your account. The provider ID is `refuseless`, not the npm package name.

## Models, effort, and credits

- **Models come from your account.** Context, image support, pricing, and available reasoning efforts come from the vendor catalog. An existing cached catalog can be used at an offline start; inference still needs network access.
- **Effort follows the selected model.** Shift+Tab cycles the levels the model accepts. Where the model supports `off`, the provider sends it explicitly.
- **Costs use the catalog's rates.** Pi accounts for cached input and any reported long-context tier. Missing pricing means the cost is unknown, not that inference is free.
- **Credits are visible in Pi.** The footer shows available credit while you're on a Refuseless model. Run `/refuseless` for the balance and current model's prices. A low-credit estimate warns without blocking the request.

Pi keeps your session and runs its tools. Refuseless serves the model over its API.

## Moving from `models.json`

If your Pi configuration already contains a `refuseless` entry in `models.json`, back up the file and remove that entry before reloading Pi. Otherwise its static model definitions can override this package's catalog entries. Leave other providers as they are.

[Provider details](DETAILS.md) · [Issues](https://github.com/kyraneth/pi-refuseless/issues) · [MIT License](LICENSE). Not affiliated with Refuseless.

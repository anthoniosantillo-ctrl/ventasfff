# Servidor de pagos PayPal (acreditación automática)

Cuando alguien paga con PayPal, el servidor confirma el pago directamente con PayPal y la página le suma el saldo al instante.

## 1. Credenciales de PayPal (cuenta Business velizanthony90@gmail.com)
1. Entra a https://developer.paypal.com con esa cuenta.
2. Dashboard → **Apps & Credentials**.
3. Arriba elige **Sandbox** (pruebas) o **Live** (dinero real).
4. **Create App** → copia el **Client ID** y el **Secret**.

El dinero llega a la cuenta dueña de esas credenciales, por eso deben ser de la cuenta Business.

## 2. Poner el servidor en línea
Necesitas un hosting con Node 18 o superior (Render, Railway, un VPS, etc.). Sube esta carpeta `servidor` junto con `index.html` (que debe quedar un nivel arriba, como está ahora). En el hosting configura estas variables:

- `PAYPAL_CLIENT_ID` y `PAYPAL_SECRET`: las del paso 1.
- `PAYPAL_ENV`: `sandbox` para probar, `live` para cobrar de verdad.
- `SITIO_URL`: la dirección pública de tu página, sin "/" final (ej. `https://mipagina.com`). PayPal devuelve al cliente a esa dirección.

Comando de inicio: `node server.js`

Si la página y el servidor están en la misma dirección, no hay nada más que hacer. Si la página está en otro sitio, haz dos cosas:
- Pon la dirección del servidor en `SERVIDOR_PAGOS` dentro de `index.html`.
- Pon la dirección de la página en la variable `ORIGEN_PERMITIDO` del servidor.

## 3. Probar antes de cobrar de verdad
1. Déjalo en `sandbox`.
2. En developer.paypal.com → Sandbox → Accounts, usa la cuenta "Personal" de prueba para pagar.
3. Haz una recarga: debe volver a tu página y sumar el saldo.
4. Cuando funcione, cambia a `live` con las credenciales Live.

## Notas
- La comisión de recarga se configura con `COMISION_RECARGA` (por defecto 2.25).
- Los pagos quedan registrados en `data/pagos.json`. Ahí puedes ver cada pago si hace falta revisar uno.
- Un pago solo se acredita una vez, aunque recarguen el enlace de retorno.
- Los saldos viven en el navegador de cada usuario (localStorage), igual que antes. El servidor confirma que el pago es real, pero un usuario que sepa de programación podría editar su propio saldo. Para evitarlo hay que mover usuarios y saldos a una base de datos en el servidor.

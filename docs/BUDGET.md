# Presupuesto personal

Esta rama añade `/budget`, una PWA mobile-first para consultar y ajustar un presupuesto personal sin exponer secretos de Enable Banking al navegador.

## Estado de la integración bancaria

El repositorio ya tenía la parte de servidor de Enable Banking:

- `src/enablebanking.ts` firma las peticiones con el `EB_APP_ID` y la clave privada RS256.
- `src/store.ts` guarda solo sesiones, identificadores de cuenta, etiquetas, consentimientos, watches y tokens OAuth. Los saldos y movimientos no se escriben en disco.
- `src/data.ts` convierte los movimientos al contrato común con gasto negativo e ingreso positivo, y detecta transferencias entre cuentas propias.
- `/callback` recibe el retorno de un consentimiento bancario.

Que Revolut y CaixaBank estén registradas en Enable Banking no implica que este servidor ya tenga un consentimiento activo ni que sus cuentas estén disponibles. Para que la web muestre datos reales deben cumplirse estos pasos:

1. La aplicación de Enable Banking debe tener como redirect URL exacta `https://TU-DOMINIO/callback`.
2. En producción, la aplicación debe estar activada mediante **Activate by linking accounts** para las cuentas propias.
3. Desde el asistente conectado a este servidor hay que ejecutar el flujo `start_consent` para Revolut y CaixaBank, abrir cada enlace, iniciar sesión en el banco y aprobar el acceso de solo lectura.
4. Tras el retorno a `/callback`, `list_accounts` debe mostrar las cuentas. La PWA las recogerá en la siguiente actualización.
5. Los consentimientos caducan; la pantalla de conexiones muestra su estado y los días restantes.

La PWA no implementa un segundo OAuth bancario ni guarda credenciales. Su login es una sesión web separada, protegida por la misma contraseña de administración del servidor. Los secretos se quedan en el backend.

## Contrato de movimientos

Cada movimiento que usa la interfaz tiene estos campos:

```ts
{
  id: string,
  date: "YYYY-MM-DD",
  amount: number,             // negativo = gasto; positivo = ingreso
  currency: string,
  bank: string,
  account: string,
  status: "pending" | "confirmed",
  source: "bank" | "manual",
  block: "needs" | "leisure" | "savings" | "unclassified",
  category: string,
  planned: boolean,
  is_transfer: boolean
}
```

Los movimientos pendientes se enseñan, pero no entran en el gasto real hasta quedar confirmados. Las transferencias entre cuentas propias se conservan en la lista y se excluyen de ingresos y gasto para no duplicarlas.

La sincronización consulta los movimientos actuales en cada cuenta conectada, sigue las páginas de Enable Banking y aplica dos defensas:

- el identificador estable de la transacción cuando el banco lo ofrece;
- una clave secundaria normalizada por fecha, importe, moneda, contraparte y descripción para descartar el mismo movimiento cuando aparece reflejado en Revolut y CaixaBank.

Dos movimientos iguales dentro del mismo banco no se eliminan automáticamente, porque pueden ser dos compras legítimas. La interfaz informa de cuántos duplicados entre bancos se descartaron.

## Presupuesto y clasificación

El ciclo comienza el día de nómina configurado, entre el 28 y el 31. Si un mes no tiene ese día, se usa el último día del mes. El gasto se clasifica por reglas de texto y puede corregirse desde la lista de movimientos. Los cambios y registros manuales sí se guardan en `DATA_DIR/bank.json`; los datos bancarios consultados no se cachean.

La bolsa de ocio mensual se divide en cuatro partes iguales. El panel muestra el gasto de la semana actual, el límite semanal y lo que queda.

## Webhooks y sincronización automática

Enable Banking no ofrece un webhook general para notificar cambios de saldos o movimientos de cuentas. Por eso `/budget` sincroniza bajo demanda al pulsar **Actualizar**. El `NOTIFY_WEBHOOK_URL` existente del repositorio se reserva para avisos de watches y accesos, no para transportar movimientos a la interfaz.

Para una actualización programada futura habría que añadir un scheduler del proveedor de despliegue o extender el watcher respetando el límite PSD2 de cuatro accesos diarios no atendidos. No se activa aquí de forma implícita.

## Despliegue

El repositorio ya contiene configuraciones para Railway, Fly.io y Render. Todas necesitan:

- un volumen persistente montado en `/data`;
- una URL pública HTTPS;
- `BASE_URL` coherente con esa URL cuando el proveedor no la detecte;
- `EB_APP_ID`, `EB_PRIVATE_KEY_PATH` o `EB_PRIVATE_KEY`, y `ADMIN_PASSWORD_HASH` solo como variables del servidor.

La configuración de CI existente ejecuta typecheck y tests en pull requests. No hay un preview web configurado en este repositorio; una URL de preview solo puede entregarse después de conectar el branch a un proveedor y sus credenciales.

/* eslint-disable no-param-reassign */
/* eslint-disable global-require */
module.exports = function HubitatDeviceModule(RED) {
  const doneWithId = require('./utils/done-with-id');

  function HubitatDeviceNode(config) {
    RED.nodes.createNode(this, config);

    this.hubitat = RED.nodes.getNode(config.server);
    this.name = config.name;
    this.deviceId = config.deviceId;
    this.sendEvent = config.sendEvent;
    this.attribute = config.attribute;
    this.shape = this.sendEvent ? 'dot' : 'ring';
    this.currentStatusText = '';
    this.currentStatusFill = undefined;
    this.wsState = '';
    this.topic = this.name || config.deviceLabel;
    const node = this;

    if (!node.hubitat) {
      node.error('Hubitat server not configured');
      return;
    }

    this.updateStatus = (fill = null, text = null) => {
      const status = { fill, shape: this.shape, text };
      node.currentStatusText = text;
      node.currentStatusFill = fill;

      if (fill === null) {
        delete status.shape;
        delete status.fill;
      }
      if (text === null) {
        delete status.text;
      }
      if (node.hubitat.useWebsocket) {
        if (fill === null) {
          status.fill = 'green';
          status.shape = this.shape;
        } else if (fill === 'blue') {
          status.fill = 'green';
        }
        if (!node.hubitat.wsStatusOk) {
          status.fill = 'red';
          status.text = 'WS ERROR';
        }
      }
      node.status(status);
    };

    async function initializeDevice() {
      try {
        await node.hubitat.devicesFetcher();
      } catch (err) {
        node.warn(`Unable to initialize device: ${err.message}`);
        node.updateStatus('red', 'Uninitialized');
        throw err;
      }
      if (node.attribute) {
        const attribute = node.hubitat.devices[node.deviceId].attributes[node.attribute];
        if (!attribute) {
          const msg = `Selected attribute (${node.attribute}) is not handled by device`;
          node.warn(msg);
          node.updateStatus('red', 'Invalid attribute');
          throw new Error(msg);
        }
        node.updateStatus('blue', `${node.attribute}: ${JSON.stringify(attribute.value)}`);
        node.log(`Initialized. ${node.attribute}: ${attribute.value}`);
      } else {
        node.updateStatus();
        node.log('Initialized');
      }
    }

    const eventCallback = async (event) => {
      node.debug(`Event received: ${JSON.stringify(event)}`);
      if (node.hubitat.devicesInitialized !== true) {
        try {
          await initializeDevice();
        } catch (err) {
          return;
        }
      }
      const attribute = node.hubitat.devices[node.deviceId].attributes[event.name];
      if (!attribute) {
        node.updateStatus('red', `Unknown event: ${event.name}`);
        return;
      }
      if ((node.attribute === event.name) || (!node.attribute)) {
        if (node.attribute) {
          node.updateStatus('blue', `${node.attribute}: ${JSON.stringify(attribute.value)}`);
          node.log(`${node.attribute}: ${attribute.value}`);
        } else {
          node.updateStatus();
          node.log(`${event.name}: ${attribute.value}`);
        }
        if (node.sendEvent) {
          const msg = { ...event, ...attribute };
          node.send({ payload: msg, topic: node.topic });
        }
      }
    };

    const systemStartCallback = async () => {
      const previousDevice = node.hubitat.expiredDevices[node.deviceId];
      const previousAttributes = previousDevice ? previousDevice.attributes : undefined;
      try {
        await initializeDevice();
      } catch (err) {
        return;
      }
      Object.values(node.hubitat.devices[node.deviceId].attributes)
        .filter((attribute) => attribute.value !== previousAttributes[attribute.name].value)
        .forEach((attribute) => {
          node.log(`Fix "${attribute.name}" attribute desynchronization: "${previousAttributes[attribute.name].value}" --> "${attribute.value}"`);
          const event = {
            name: attribute.name,
            value: attribute.value,
            currentValue: attribute.value,
            descriptionText: 'Event triggered by systemStart and generated by Node-RED',
          };
          eventCallback(event);
        });
    };
    if (node.deviceId) {
      this.hubitat.hubitatEvent.on(`device.${node.deviceId}`, eventCallback);
      this.hubitat.hubitatEvent.on('systemStart', systemStartCallback);
    }

    const wsOpened = async () => {
      node.updateStatus(node.currentStatusFill, node.currentStatusText);
    };
    this.hubitat.hubitatEvent.on('websocket-opened', wsOpened);
    const wsClosed = async () => {
      node.updateStatus(node.currentStatusFill, node.currentStatusText);
    };
    this.hubitat.hubitatEvent.on('websocket-closed', wsClosed);
    this.hubitat.hubitatEvent.on('websocket-error', wsClosed);

    initializeDevice().catch(() => {});

    node.on('input', async (msg, send, done) => {
      node.debug('Input received');
      if (node.hubitat.devicesInitialized !== true) {
        try {
          await initializeDevice();
        } catch (err) {
          return;
        }
      }

      const deviceId = ((msg.deviceId !== undefined) ? msg.deviceId : node.deviceId);
      if (!deviceId) {
        const errorMsg = 'Undefined device ID';
        node.updateStatus('red', errorMsg);
        doneWithId(node, done, errorMsg);
        return;
      }

      const attributeSearched = msg.attribute || node.attribute;
      if (!attributeSearched) {
        msg.payload = { ...node.hubitat.devices[deviceId].attributes };
        msg.topic = node.topic;
        send(msg);
        node.updateStatus();
        done();
        return;
      }

      const attribute = node.hubitat.devices[deviceId].attributes[attributeSearched];
      if (!attribute) {
        const errorMsg = `Invalid attribute: ${attributeSearched}`;
        node.updateStatus('red', errorMsg);
        doneWithId(node, done, errorMsg);
        return;
      }

      msg.payload = { ...attribute };
      msg.topic = node.topic;
      send(msg);
      if (!node.attribute) {
        node.updateStatus();
      } else if (node.attribute === attribute.name) {
        node.updateStatus('blue', `${node.attribute}: ${JSON.stringify(attribute.value)}`);
      }
      done();
    });

    node.on('close', () => {
      node.debug('Closed');
      if (node.deviceId) {
        this.hubitat.hubitatEvent.removeListener(`device.${node.deviceId}`, eventCallback);
        this.hubitat.hubitatEvent.removeListener('systemStart', systemStartCallback);
      }
      this.hubitat.hubitatEvent.removeListener('websocket-opened', wsOpened);
      this.hubitat.hubitatEvent.removeListener('websocket-closed', wsClosed);
      this.hubitat.hubitatEvent.removeListener('websocket-error', wsClosed);
    });
  }

  RED.nodes.registerType('hubitat device', HubitatDeviceNode);
};

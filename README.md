# BIOGLOW FLL Robot Simulator

A browser simulator for practising FIRST LEGO League robot runs on the BIOGLOW field.

**Try it here:** https://beckettbrookshear.github.io/bioglow-simulator/

You can also download this repo and open `index.html` in a browser. No server or install is needed.

## Real robot

On the Robot tab, **Real robot** connects to a SPIKE Prime hub over Bluetooth (Chrome or Edge, SPIKE App 3 firmware). It shows the hub's live readings, draws a "ghost" of the real robot on the field, and **Run on both** runs a program on the simulator and the real robot side by side, with charts comparing them. It uses LEGO's published [SPIKE Prime hub protocol](https://lego.github.io/spike-prime-docs/). To try it without a robot, open the simulator with `?mockhub` at the end of the address.

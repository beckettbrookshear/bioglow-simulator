# BIOGLOW FLL Robot Simulator

A browser simulator for practising FIRST LEGO League robot runs on the BIOGLOW field.

**Try it here:** https://beckettbrookshear.github.io/bioglow-simulator/

You can also download this repo and open `index.html` in a browser. No server or install is needed.

## Mission models and photo attachments

Each mission model's moving part works like the real one: some are pushed (the ant into its nest, M06), some pulled with a hook from behind (the mycelium, M07; the root cover, M11; the compost hatch, M15), some lifted from underneath by a motor-driven attachment (M09 platform, M12 cane, M15 canopy), and seeds are knocked off (M02, M09). The **Lift arm** attachment does the lifting. On the Robot tab, **Make an attachment from photos** turns two photos of your own attachment (from the side and from above) into a 3D model fitted to an attachment motor, so programs drive it by turning that motor. It's built from the two outlines and kept in your browser.

## Real robot

On the Robot tab, **Real robot** connects to a SPIKE Prime hub over Bluetooth (Chrome or Edge, SPIKE App 3 firmware). It shows the hub's live readings, draws a "ghost" of the real robot on the field, and **Run on both** runs a program on the simulator and the real robot side by side, with charts comparing them. It uses LEGO's published [SPIKE Prime hub protocol](https://lego.github.io/spike-prime-docs/). To try it without a robot, open the simulator with `?mockhub` at the end of the address.

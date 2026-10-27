// Example: M03 flip the rock (and put it back), M13 deliver the keystone species (the young
// trees rise when it lands), then M02 knock the seeds off the stalk.
// The robot starts in the left launch area facing east (heading 90).

await robot.grab();            // close the basket on the keystone species
await robot.drive(20);         // out of the launch area
await robot.turnTo(0);         // face north
await robot.drive(48.3);       // level with the rock

// M03: the keystone in the basket pushes the rock's lever. Push once to flip the rock
// (research flag down), back off, and push again to put the rock back.
await robot.turnTo(270);       // face west
await robot.drive(8, 30);
await robot.drive(-4, 30);
await robot.drive(4.5, 30);
await robot.drive(-8.5);

// M13: across to the restoration platform on the farm dock, north of the seed pod's tubes.
await robot.turnTo(0);         // face north
await robot.drive(3.9);
await robot.turnTo(90);        // face east
await robot.drive(40, 40);     // up against the restoration platform (it stops there)
await robot.release();         // the keystone stays on it and the young trees rise
await robot.drive(-8);

// M02: back to the seed pod. With the basket open, its arms knock the three hanging seeds
// off the stalk's tubes.
await robot.turnTo(270);       // face west
await robot.drive(25.6);
await robot.turnTo(180);       // face south
await robot.drive(32.8);
await robot.turnTo(90);
await robot.drive(5.9);
await robot.turnTo(45);        // square on to the seed pod
await robot.drive(6.6, 30);
await robot.drive(-6.6);
robot.log('Done at', robot.time(), 's');

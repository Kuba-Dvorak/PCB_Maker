#include <Arduino.h>

// Stejny pinout jako v nanoCode/src/main.cpp:
//   cnc myCNC = cnc({3,4,5,6,7,8,9}, {10,16,12,13,14,15});
//   setupPins(motorPins[0] = enable,
//             motorPins[1] = stepX, motorPins[2] = dirX,
//             motorPins[3] = stepY, motorPins[4] = dirY,
//             motorPins[5] = stepZ, motorPins[6] = dirZ)
#define ENABLE_PIN 3

#define STEP_X 4
#define DIR_X  5
#define STEP_Y 6
#define DIR_Y  7
#define STEP_Z 8
#define DIR_Z  9

#define LED_PIN 19

#define STEPS        500   // kroku na jeden smer
#define STEP_HIGH_US 3     // HIGH pulz na STEP (A4988 chce min 1 us, DRV8825 min 1.9 us)
#define STEP_LOW_US  1997  // LOW mezi pulzy -> perioda 2 ms -> 500 kroku/s
#define DIR_SETUP_US 5     // DIR musi byt ustaleny pred hranou STEP
#define PAUSE_MS     500   // pauza mezi smery


void stepAll(uint16_t steps) {
    for (uint16_t i = 0; i < steps; ++i) {
        digitalWrite(STEP_X, HIGH);
        digitalWrite(STEP_Y, HIGH);
        digitalWrite(STEP_Z, HIGH);
        delayMicroseconds(STEP_HIGH_US);

        digitalWrite(STEP_X, LOW);
        digitalWrite(STEP_Y, LOW);
        digitalWrite(STEP_Z, LOW);
        delayMicroseconds(STEP_LOW_US);
    }
}


void setDirAll(uint8_t level) {
    digitalWrite(DIR_X, level);
    digitalWrite(DIR_Y, level);
    digitalWrite(DIR_Z, level);
    delayMicroseconds(DIR_SETUP_US);
}


void setup() {
    pinMode(LED_PIN, OUTPUT);
    digitalWrite(LED_PIN, HIGH);

    // ENABLE je na A4988/DRV8825 active-low, takze HIGH = drivery vypnute.
    // Shazujeme ho az uplne na konci setupu, at motory nedrzi proud driv,
    // nez maji STEP a DIR definovanou uroven.
    pinMode(ENABLE_PIN, OUTPUT);
    digitalWrite(ENABLE_PIN, HIGH);

    pinMode(STEP_X, OUTPUT);
    pinMode(DIR_X, OUTPUT);
    pinMode(STEP_Y, OUTPUT);
    pinMode(DIR_Y, OUTPUT);
    pinMode(STEP_Z, OUTPUT);
    pinMode(DIR_Z, OUTPUT);

    digitalWrite(STEP_X, LOW);
    digitalWrite(STEP_Y, LOW);
    digitalWrite(STEP_Z, LOW);

    Serial.begin(115200);
    delay(2000);
    Serial.println("[TEST] Motor test: 500 kroku tam, 500 ms pauza, 500 kroku zpet, vsechny 3 osy naraz.");
    Serial.print("[TEST] Rychlost: ");
    Serial.print(1000000UL / (STEP_HIGH_US + STEP_LOW_US));
    Serial.println(" kroku/s.");

    digitalWrite(ENABLE_PIN, LOW);
    delay(10);
}


void loop() {
    digitalWrite(LED_PIN, LOW);
    Serial.println("[TEST] DIR = HIGH, jedu 500 kroku.");
    setDirAll(HIGH);
    stepAll(STEPS);

    digitalWrite(LED_PIN, HIGH);
    Serial.println("[TEST] Pauza 500 ms.");
    delay(PAUSE_MS);

    digitalWrite(LED_PIN, LOW);
    Serial.println("[TEST] DIR = LOW, jedu 500 kroku zpet.");
    setDirAll(LOW);
    stepAll(STEPS);

    digitalWrite(LED_PIN, HIGH);
    Serial.println("[TEST] Pauza 500 ms.");
    delay(PAUSE_MS);
}

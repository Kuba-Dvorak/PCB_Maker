#include <Arduino.h>
#include <Wire.h>
#include <array>

#include "vector"


// v commandu jsem pouzil to ze kdyz je treba G1 tak to je 1, G21 je 21, jasne?a


struct globalInfo {
    int curStepX, curStepY;
    int maxStepX, maxStepY;
    uint8_t pinX, pinY;
    int taskDone;
    bool stopXfront, stopYfront, stopZfront, stopXend, stopYend, stopZend;
};


globalInfo createGlobalInfo() {
    globalInfo oneInfo;
    oneInfo.curStepX = 0;
    oneInfo.curStepY = 0;
    oneInfo.maxStepX = 1000;
    oneInfo.maxStepY = 1000;
    oneInfo.pinX = 2;
    oneInfo.pinY = 3;
    oneInfo.taskDone = 2;
    oneInfo.stopXfront = false;
    oneInfo.stopYfront = false;
    oneInfo.stopZfront = false;

    oneInfo.stopXend = false;
    oneInfo.stopYend = false;
    oneInfo.stopZend = false;
    return oneInfo;
}


volatile globalInfo myGlobalInfo = createGlobalInfo();


struct position {
    float x, y;
};


//cmd 1 = jednoduchy move, cmd 0 = ping a otestovani, cmd 2 = nastaveni rychlosti spindl, cmd 3 = homing, cmd 4 = homing na MAX vseho
struct basicCMD {
    uint8_t command;
    position position;
    float z, speed;
};


struct nanoReport {
    uint8_t status;
    uint8_t error;
    position position;
    float z;
    float speed;
};


struct calibration {
    float stepTimeX, stepTimeY, stepTimeZ;
    float stepLenghtX, stepLenghtY, stepLenghtZ; // pocet kroku na 1 mm!!!!
};


struct toolheadInfo {
    position position;
    float z, speed;
};


calibration basicCalib() {
    calibration calib;
    calib.stepTimeX = 0.001;
    calib.stepTimeY = 0.001;
    calib.stepTimeZ = 0.001;

    calib.stepLenghtX = 10;
    calib.stepLenghtY = 10;
    calib.stepLenghtZ = 10;

    return calib;
}


toolheadInfo basicToolHead() {
    toolheadInfo toolHead;
    toolHead.position.x = 0;
    toolHead.position.y = 0;
    toolHead.z = 0;
    toolHead.speed = 1;

    return toolHead;
}


static void timer1Start(uint32_t freq) {
    noInterrupts();

    TCCR1A = 0;
    TCCR1B = 0;
    TCNT1 = 0;

    if (freq < 1) freq = 1;
    if (freq > 20000) freq = 20000;

    OCR1A = (2000000UL / freq) - 1;

    TCCR1A |= (1 << CS11);
    TCCR1B |= (1 << WGM12);
    TIMSK1 |= (1 << OCIE1A);

    interrupts();
}


static void timer1Stop() {
    TIMSK1 &= ~(1 << OCIE1A);
    TCCR1B = 0;
}


static void timer2Start(uint32_t freq) {
    noInterrupts();

    TCCR2A = 0;
    TCCR2B = 0;
    TCNT2 = 0;

    if (freq < 61) freq = 61;
    if (freq > 5000) freq = 5000;

    OCR2A = (15625UL / freq) - 1;

    TCCR2A |= (1 << WGM21);
    TCCR2B |= (1 << CS22) | (1 << CS21) | (1 << CS20);
    TIMSK2 |= (1 << OCIE2A);

    interrupts();
}


static void timer2Stop() {
    TIMSK2 &= ~(1 << OCIE2A);
    TCCR2B = 0;
}


void inline interuptFunc(uint8_t pin) {
    digitalWrite(pin, LOW);
    if (!myGlobalInfo.stopXfront && !myGlobalInfo.stopXend && !myGlobalInfo.stopYfront && !myGlobalInfo.stopYend) {
        digitalWrite(pin, HIGH);
        delayMicroseconds(2);
        digitalWrite(pin, LOW);
    }
}


ISR(TIMER1_COMPA_vect) {
    interuptFunc(myGlobalInfo.pinX);
    myGlobalInfo.curStepX += 1;
    if (myGlobalInfo.curStepX >= myGlobalInfo.maxStepX) {
        timer1Stop();
        myGlobalInfo.curStepX = 0;
        myGlobalInfo.taskDone += 1;
    }
}


ISR(TIMER2_COMPA_vect) {
    interuptFunc(myGlobalInfo.pinY);
    myGlobalInfo.curStepY += 1;
    if (myGlobalInfo.curStepY >= myGlobalInfo.maxStepY) {
        timer2Stop();
        myGlobalInfo.curStepY = 0;
        myGlobalInfo.taskDone += 1;
    }
}


struct cnc {
    calibration myCalib;
    toolheadInfo myToolHead;
    std::array<int, 9> motorPins; // X step, X dir, X ena, Y .... Z ...
    uint8_t spindlPin;
    std::array<int, 6> endStop;
    std::vector<basicCMD> cmdQueue;

    cnc(std::array<int, 9> motorPins, std::array<int, 6> endStop, uint8_t spindlPin) {
        this->motorPins = motorPins;
        this->endStop = endStop;
        this->spindlPin = spindlPin;
        myCalib = basicCalib();
        myToolHead = basicToolHead();
        cmdQueue.reserve(8);
    }

    void operateInstr() {
        if (cmdQueue.size() > 8) {
            cmdQueue.erase(cmdQueue.begin());
        }
        loadCMD();
        if (!cmdQueue.empty()) {
            basicCMD cmd = cmdQueue[0];
            if (!(cmd.speed == -1)) {
                myToolHead.speed = cmd.speed;
            }
            if (!(cmd.z == myToolHead.z) && !(cmd.z == -1)) {
                moveZ(cmd.z);
            }
            if (cmd.command == 1) {
                move2D(cmd.position);
            }
            if (cmd.command == 0) {
                pingBack();
            }
        }
    }

    void loadCMD() {

    }

    void pingBack() {
        // send back a ping response
    }

    void moveZ(float z) {
        if (z >= myToolHead.z) {
            digitalWrite(motorPins[7], HIGH);
        }

        else {
            digitalWrite(motorPins[7], LOW);
        }
        int maxStepZ = abs(myCalib.stepLenghtZ * (z - myToolHead.z));
        digitalWrite(motorPins[6], LOW);
        for (int i = 0; i < maxStepZ; i++) {
            if (myGlobalInfo.stopZfront || myGlobalInfo.stopZend) {
                break;
            }
            digitalWrite(motorPins[6], HIGH);
            delayMicroseconds(100);
            digitalWrite(motorPins[6], LOW);
        }

        myToolHead.z = z;
    }

    void move2D(position location) {
        if (location.x >= myToolHead.position.x) {
            digitalWrite(motorPins[1], HIGH);
        }

        else {
            digitalWrite(motorPins[1], LOW);
        }

        if (location.y >= myToolHead.position.y) {
            digitalWrite(motorPins[4], HIGH);
        }

        else {
            digitalWrite(motorPins[4], LOW);
        }
        float lenghtX = location.x - myToolHead.position.x;
        float lenghtY = location.y - myToolHead.position.y;
        float lenght = sqrt(pow((lenghtX), 2) + pow((lenghtY), 2));
        float totalTime = lenght / myToolHead.speed;
        myGlobalInfo.maxStepX = abs(myCalib.stepLenghtX * lenghtX);
        myGlobalInfo.maxStepY = abs(myCalib.stepLenghtY * lenghtY);
        int freqX = int(myGlobalInfo.maxStepX / totalTime); // matematicky prepis tohodle:  1 / (totalTime / totalStepsX)
        int freqY = int(myGlobalInfo.maxStepY / totalTime);

        myGlobalInfo.taskDone = 0;
        timer1Start(freqX);
        timer2Start(freqY);
        myToolHead.position = location;
    }

    void controlSpindl(uint8_t speed) {
        if (speed <= 0) {
            digitalWrite(spindlPin, LOW);
        }
        if (speed >= 255) {
            digitalWrite(spindlPin, HIGH);
        }
        analogWrite(spindlPin, speed);
    }
};


void setup() {
    // write your initialization code here
}

void loop() {
    // write your code here
}
